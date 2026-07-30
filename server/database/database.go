package database

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/luftaquila/skytrace/server/config"
	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaFiles embed.FS

var canonicalSchema = mustSchema()

type DB struct {
	SQL  *sql.DB
	Path string
}

func Open(ctx context.Context, path string) (*DB, error) {
	if path == "" {
		return nil, errors.New("database path is empty")
	}
	memory := path == ":memory:"
	resolved := path
	if !memory {
		var err error
		resolved, err = filepath.Abs(path)
		if err != nil {
			return nil, fmt.Errorf("resolve database path: %w", err)
		}
		if err := secureDirectory(filepath.Dir(resolved)); err != nil {
			return nil, err
		}
		if err := rejectSymlink(resolved); err != nil {
			return nil, err
		}
	}

	dsn := ":memory:"
	if !memory {
		location := url.URL{Scheme: "file", Path: resolved}
		dsn = location.String()
	}
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	db := &DB{SQL: sqlDB, Path: resolved}
	if err := db.initialize(ctx, memory); err != nil {
		sqlDB.Close()
		return nil, err
	}
	if !memory {
		for _, file := range []string{resolved, resolved + "-wal", resolved + "-shm"} {
			if err := secureFile(file); err != nil {
				sqlDB.Close()
				return nil, err
			}
		}
	}
	return db, nil
}

func (db *DB) initialize(ctx context.Context, memory bool) error {
	if err := db.SQL.PingContext(ctx); err != nil {
		return err
	}
	if !memory {
		var journalMode string
		if err := db.SQL.QueryRowContext(ctx, "PRAGMA journal_mode = WAL").Scan(&journalMode); err != nil {
			return fmt.Errorf("enable WAL: %w", err)
		}
		if strings.ToLower(journalMode) != "wal" {
			return fmt.Errorf("enable WAL: SQLite selected %s", journalMode)
		}
	}
	for _, pragma := range []string{"PRAGMA foreign_keys = ON", "PRAGMA busy_timeout = 5000"} {
		if _, err := db.SQL.ExecContext(ctx, pragma); err != nil {
			return err
		}
	}
	if err := Migrate(ctx, db.SQL); err != nil {
		return err
	}
	return nil
}

func (db *DB) Close() error {
	return db.SQL.Close()
}

func Migrate(ctx context.Context, db *sql.DB) error {
	var tableCount int
	if err := db.QueryRowContext(ctx, `
		SELECT count(*) FROM sqlite_master
		WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
	`).Scan(&tableCount); err != nil {
		return err
	}
	if tableCount == 0 {
		if _, err := db.ExecContext(ctx, canonicalSchema); err != nil {
			return fmt.Errorf("create canonical schema: %w", err)
		}
	}
	problems, err := canonicalProblems(ctx, db)
	if err != nil {
		return err
	}
	if len(problems) != 0 {
		return fmt.Errorf(
			"database schema is not canonical; run the offline migration first (%s)",
			strings.Join(problems, "; "),
		)
	}
	return nil
}

func SyncReceiverTokens(ctx context.Context, db *sql.DB, entries []config.ReceiverToken, now time.Time) error {
	transaction, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()

	upsertReceiver, err := transaction.PrepareContext(ctx, `
		INSERT INTO receivers (id, name, public_name, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
	`)
	if err != nil {
		return err
	}
	defer upsertReceiver.Close()
	upsertToken, err := transaction.PrepareContext(ctx, `
		INSERT INTO receiver_tokens (receiver_id, token_hash)
		VALUES (?, ?)
		ON CONFLICT(token_hash) DO UPDATE SET receiver_id = excluded.receiver_id
	`)
	if err != nil {
		return err
	}
	defer upsertToken.Close()

	configured := make(map[string]struct{}, len(entries))
	timestamp := ISOTime(now)
	for _, entry := range entries {
		tokenHash := HashToken(entry.Token)
		configured[tokenHash] = struct{}{}
		if _, err := upsertReceiver.ExecContext(ctx, entry.ReceiverID, entry.ReceiverID, entry.ReceiverID, timestamp); err != nil {
			return err
		}
		if _, err := upsertToken.ExecContext(ctx, entry.ReceiverID, tokenHash); err != nil {
			return err
		}
	}

	rows, err := transaction.QueryContext(ctx, "SELECT token_hash FROM receiver_tokens")
	if err != nil {
		return err
	}
	var existing []string
	for rows.Next() {
		var hash string
		if err := rows.Scan(&hash); err != nil {
			rows.Close()
			return err
		}
		existing = append(existing, hash)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, hash := range existing {
		if _, ok := configured[hash]; ok {
			continue
		}
		if _, err := transaction.ExecContext(ctx, "DELETE FROM receiver_tokens WHERE token_hash = ?", hash); err != nil {
			return err
		}
	}
	return transaction.Commit()
}

func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func ISOTime(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func QuickCheck(ctx context.Context, db *sql.DB) error {
	var result string
	if err := db.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&result); err != nil {
		return err
	}
	if result != "ok" {
		return fmt.Errorf("database quick_check failed: %s", result)
	}
	rows, err := db.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return err
	}
	defer rows.Close()
	if rows.Next() {
		return errors.New("database foreign_key_check failed")
	}
	return rows.Err()
}

func secureDirectory(path string) error {
	resolved := filepath.Clean(path)
	if err := os.MkdirAll(resolved, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(resolved)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("database directory must be a real directory: %s", resolved)
	}
	if info.Mode().Perm()&0o077 != 0 {
		if info.Mode()&os.ModeSticky != 0 || resolved == filepath.VolumeName(resolved)+string(filepath.Separator) {
			return fmt.Errorf("database directory must not be shared: %s", resolved)
		}
		if err := os.Chmod(resolved, 0o700); err != nil {
			return err
		}
	}
	info, err = os.Lstat(resolved)
	if err != nil {
		return err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("database directory permissions must be 0700: %s", resolved)
	}
	return nil
}

func rejectSymlink(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return fmt.Errorf("database path must be a regular file: %s", path)
	}
	return nil
}

func secureFile(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return fmt.Errorf("database path must be a regular file: %s", path)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return err
	}
	info, err = os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode().Perm()&0o177 != 0 {
		return fmt.Errorf("database file permissions must be 0600: %s", path)
	}
	return nil
}

func mustSchema() string {
	bytes, err := schemaFiles.ReadFile("schema.sql")
	if err != nil {
		panic(err)
	}
	return string(bytes)
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
