package database

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
)

var expectedColumns = map[string][]string{
	"receivers": {
		"id", "name", "public_name", "lat", "lon", "last_seen_at", "last_ip", "user_agent",
		"total_ingests", "created_at", "updated_at",
	},
	"receiver_tokens": {"receiver_id", "token_hash", "created_at", "last_used_at"},
	"ingest_batches": {
		"id", "receiver_id", "received_at", "source_now", "aircraft_count", "accepted_count",
		"track_points", "remote_addr",
	},
	"receiver_aircraft_current": {
		"receiver_id", "hex", "observed_at", "position_at", "lat", "lon", "flight", "alt_baro",
		"alt_geom", "on_ground", "gs", "ias", "tas", "mach", "track", "true_heading",
		"mag_heading", "baro_rate", "geom_rate", "track_rate", "roll", "squawk", "category",
		"source_type", "source_kind", "emergency", "nav_qnh", "nav_altitude_mcp",
		"nav_altitude_fms", "nav_heading", "wd", "ws", "oat", "tat", "nac_p", "nac_v",
		"nic", "nic_baro", "rc", "sil", "sil_type", "version", "alert", "spi", "non_icao",
		"messages", "rssi", "seen_seconds", "seen_pos_seconds",
	},
	"track_points": {
		"id", "hex", "receiver_id", "observed_at", "position_at", "lat", "lon", "alt_baro",
		"alt_geom", "on_ground", "gs", "ias", "tas", "mach", "track", "true_heading",
		"mag_heading", "baro_rate", "geom_rate", "wd", "ws", "oat", "tat", "source_type",
		"messages", "rssi", "created_at",
	},
	"coverage_receiver_state": {
		"receiver_id", "config_key", "origin_lat", "origin_lon", "last_track_id", "updated_at",
	},
	"coverage_track_state": {
		"receiver_id", "hex", "position_at", "lat", "lon", "altitude_ft",
	},
	"coverage_cells": {
		"receiver_id", "config_key", "cell_x", "cell_y", "cell_z", "lat", "lon",
		"altitude_ft", "last_seen_at", "hit_count",
	},
}

var expectedIndexes = map[string]struct{}{
	"idx_receiver_current_observed": {},
	"idx_receiver_current_hex":      {},
	"idx_track_hex_time":            {},
	"idx_track_hex_id":              {},
	"idx_track_time":                {},
	"idx_track_receiver_id":         {},
	"idx_track_receiver_time":       {},
	"idx_batches_received":          {},
	"idx_batches_receiver_time":     {},
	"idx_coverage_cells_active":     {},
	"idx_coverage_track_state_time": {},
}

type schemaObject struct {
	Type  string `json:"type"`
	Name  string `json:"name"`
	Table string `json:"table"`
	SQL   string `json:"sql"`
}

type columnDetail struct {
	Name         string  `json:"name"`
	Type         string  `json:"type"`
	NotNull      int     `json:"notNull"`
	DefaultValue *string `json:"defaultValue"`
	PrimaryKey   int     `json:"primaryKey"`
}

type foreignKeyDetail struct {
	ID       int    `json:"id"`
	Seq      int    `json:"seq"`
	Table    string `json:"table"`
	From     string `json:"from"`
	To       string `json:"to"`
	OnUpdate string `json:"onUpdate"`
	OnDelete string `json:"onDelete"`
	Match    string `json:"match"`
}

type indexDetail struct {
	Name    string   `json:"name"`
	Unique  int      `json:"unique"`
	Origin  string   `json:"origin"`
	Partial int      `json:"partial"`
	Columns []string `json:"columns"`
}

type tableDetail struct {
	Columns     []columnDetail     `json:"columns"`
	ForeignKeys []foreignKeyDetail `json:"foreignKeys"`
	Indexes     []indexDetail      `json:"indexes"`
}

type fingerprintDocument struct {
	Objects []schemaObject         `json:"objects"`
	Details map[string]tableDetail `json:"details"`
}

func Fingerprint(ctx context.Context, db *sql.DB) (string, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT type, name, tbl_name, sql
		FROM sqlite_master
		WHERE name NOT LIKE 'sqlite_%'
		  AND type IN ('table', 'index')
		ORDER BY type, name
	`)
	if err != nil {
		return "", err
	}
	var objects []schemaObject
	for rows.Next() {
		var object schemaObject
		var rawSQL sql.NullString
		if err := rows.Scan(&object.Type, &object.Name, &object.Table, &rawSQL); err != nil {
			rows.Close()
			return "", err
		}
		object.SQL = normalizeObjectSQL(object.Type, object.Name, rawSQL.String)
		objects = append(objects, object)
	}
	if err := rows.Close(); err != nil {
		return "", err
	}

	details := make(map[string]tableDetail)
	for _, object := range objects {
		if object.Type != "table" {
			continue
		}
		detail, err := inspectTable(ctx, db, object.Name)
		if err != nil {
			return "", err
		}
		details[object.Name] = detail
	}
	encoded, err := json.Marshal(fingerprintDocument{Objects: objects, Details: details})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

func inspectTable(ctx context.Context, db *sql.DB, table string) (tableDetail, error) {
	detail := tableDetail{
		Columns:     []columnDetail{},
		ForeignKeys: []foreignKeyDetail{},
		Indexes:     []indexDetail{},
	}
	rows, err := db.QueryContext(ctx, "PRAGMA table_info("+quoteIdentifier(table)+")")
	if err != nil {
		return detail, err
	}
	for rows.Next() {
		var sequence int
		var column columnDetail
		var defaultValue sql.NullString
		if err := rows.Scan(
			&sequence,
			&column.Name,
			&column.Type,
			&column.NotNull,
			&defaultValue,
			&column.PrimaryKey,
		); err != nil {
			rows.Close()
			return detail, err
		}
		if defaultValue.Valid {
			column.DefaultValue = &defaultValue.String
		}
		detail.Columns = append(detail.Columns, column)
	}
	if err := rows.Close(); err != nil {
		return detail, err
	}

	rows, err = db.QueryContext(ctx, "PRAGMA foreign_key_list("+quoteIdentifier(table)+")")
	if err != nil {
		return detail, err
	}
	for rows.Next() {
		var key foreignKeyDetail
		if err := rows.Scan(
			&key.ID,
			&key.Seq,
			&key.Table,
			&key.From,
			&key.To,
			&key.OnUpdate,
			&key.OnDelete,
			&key.Match,
		); err != nil {
			rows.Close()
			return detail, err
		}
		detail.ForeignKeys = append(detail.ForeignKeys, key)
	}
	if err := rows.Close(); err != nil {
		return detail, err
	}

	rows, err = db.QueryContext(ctx, "PRAGMA index_list("+quoteIdentifier(table)+")")
	if err != nil {
		return detail, err
	}
	for rows.Next() {
		var sequence int
		var index indexDetail
		if err := rows.Scan(&sequence, &index.Name, &index.Unique, &index.Origin, &index.Partial); err != nil {
			rows.Close()
			return detail, err
		}
		detail.Indexes = append(detail.Indexes, index)
	}
	if err := rows.Close(); err != nil {
		return detail, err
	}
	for position := range detail.Indexes {
		index := &detail.Indexes[position]
		columnRows, err := db.QueryContext(ctx, "PRAGMA index_info("+quoteIdentifier(index.Name)+")")
		if err != nil {
			return detail, err
		}
		for columnRows.Next() {
			var rank, cid int
			var name sql.NullString
			if err := columnRows.Scan(&rank, &cid, &name); err != nil {
				columnRows.Close()
				return detail, err
			}
			if name.Valid {
				index.Columns = append(index.Columns, name.String)
			} else {
				index.Columns = append(index.Columns, "")
			}
		}
		if err := columnRows.Close(); err != nil {
			return detail, err
		}
	}
	sort.Slice(detail.Indexes, func(i, j int) bool {
		return detail.Indexes[i].Name < detail.Indexes[j].Name
	})
	return detail, nil
}

func canonicalProblems(ctx context.Context, db *sql.DB) ([]string, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT name FROM sqlite_master
		WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
		ORDER BY name
	`)
	if err != nil {
		return nil, err
	}
	var tables []string
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			rows.Close()
			return nil, err
		}
		tables = append(tables, table)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	var problems []string
	expectedTables := sortedKeys(expectedColumns)
	if strings.Join(tables, "\n") != strings.Join(expectedTables, "\n") {
		actual := strings.Join(tables, ", ")
		if actual == "" {
			actual = "(none)"
		}
		problems = append(problems, "tables are "+actual)
	}
	tableSet := make(map[string]struct{}, len(tables))
	for _, table := range tables {
		tableSet[table] = struct{}{}
	}
	for _, table := range expectedTables {
		if _, ok := tableSet[table]; !ok {
			continue
		}
		rows, err := db.QueryContext(ctx, "PRAGMA table_info("+quoteIdentifier(table)+")")
		if err != nil {
			return nil, err
		}
		var columns []string
		for rows.Next() {
			var sequence, notNull, primaryKey int
			var name, dataType string
			var defaultValue sql.NullString
			if err := rows.Scan(&sequence, &name, &dataType, &notNull, &defaultValue, &primaryKey); err != nil {
				rows.Close()
				return nil, err
			}
			columns = append(columns, name)
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
		if strings.Join(columns, "\n") != strings.Join(expectedColumns[table], "\n") {
			problems = append(problems, fmt.Sprintf("%s columns are %s", table, strings.Join(columns, ", ")))
		}
	}

	rows, err = db.QueryContext(ctx, `
		SELECT name FROM sqlite_master
		WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'
	`)
	if err != nil {
		return nil, err
	}
	indexes := make(map[string]struct{})
	for rows.Next() {
		var index string
		if err := rows.Scan(&index); err != nil {
			rows.Close()
			return nil, err
		}
		indexes[index] = struct{}{}
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	indexMismatch := len(indexes) != len(expectedIndexes)
	if !indexMismatch {
		for index := range expectedIndexes {
			if _, ok := indexes[index]; !ok {
				indexMismatch = true
				break
			}
		}
	}
	if indexMismatch {
		names := sortedKeys(indexes)
		actual := strings.Join(names, ", ")
		if actual == "" {
			actual = "(none)"
		}
		problems = append(problems, "indexes are "+actual)
	}

	if len(problems) == 0 {
		actual, err := Fingerprint(ctx, db)
		if err != nil {
			return nil, err
		}
		expected, err := expectedFingerprintValue(ctx)
		if err != nil {
			return nil, err
		}
		if actual != expected {
			problems = append(problems, "table constraints, foreign keys or index definitions differ")
		}
	}
	return problems, nil
}

var (
	expectedFingerprintOnce sync.Once
	expectedFingerprint     string
	expectedFingerprintErr  error
)

func expectedFingerprintValue(ctx context.Context) (string, error) {
	expectedFingerprintOnce.Do(func() {
		fixture, err := sql.Open("sqlite", ":memory:")
		if err != nil {
			expectedFingerprintErr = err
			return
		}
		defer fixture.Close()
		fixture.SetMaxOpenConns(1)
		if _, err := fixture.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
			expectedFingerprintErr = err
			return
		}
		if _, err := fixture.ExecContext(ctx, canonicalSchema); err != nil {
			expectedFingerprintErr = err
			return
		}
		expectedFingerprint, expectedFingerprintErr = Fingerprint(ctx, fixture)
	})
	return expectedFingerprint, expectedFingerprintErr
}

func normalizeObjectSQL(objectType, name, value string) string {
	normalized := strings.Join(strings.Fields(value), " ")
	if objectType != "table" {
		return normalized
	}
	pattern := regexp.MustCompile(`(?i)^CREATE TABLE ["'\x60]?` + regexp.QuoteMeta(name) + `["'\x60]?`)
	return pattern.ReplaceAllString(normalized, "CREATE TABLE "+name)
}

func quoteIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}
