package tracks

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/luftaquila/skytrace/server/ingest"
)

const (
	MaxBulkAircraft      = 32
	MaxBulkRows          = 10000
	MaxBulkLookbackHours = 24
)

type BulkAircraftRequest struct {
	Hex     string
	AfterID int64
}

type BulkRequest struct {
	Aircraft []BulkAircraftRequest
	Detail   string
}

type BulkTrack struct {
	Hex           string           `json:"hex"`
	CursorID      int64            `json:"cursorId"`
	HasMore       bool             `json:"hasMore"`
	ResetRequired bool             `json:"resetRequired"`
	Truncated     bool             `json:"truncated"`
	Points        []map[string]any `json:"points"`
}

type BulkResponse struct {
	Tracks []BulkTrack `json:"tracks"`
}

func NormalizeBulkRequest(body any) (BulkRequest, bool) {
	object, ok := body.(map[string]any)
	if !ok {
		return BulkRequest{}, false
	}
	for key := range object {
		if key != "aircraft" && key != "detail" {
			return BulkRequest{}, false
		}
	}
	rawAircraft, ok := object["aircraft"].([]any)
	if !ok || len(rawAircraft) > MaxBulkAircraft {
		return BulkRequest{}, false
	}
	detail := ""
	if value, exists := object["detail"]; exists && value != nil {
		text, ok := requestString(value)
		if !ok {
			return BulkRequest{}, false
		}
		detail = strings.ToLower(strings.TrimSpace(text))
		if !ingest.IsValidAircraftID(detail) {
			return BulkRequest{}, false
		}
	}
	seen := make(map[string]struct{}, len(rawAircraft))
	request := BulkRequest{Aircraft: make([]BulkAircraftRequest, 0, len(rawAircraft)), Detail: detail}
	for _, raw := range rawAircraft {
		item, ok := raw.(map[string]any)
		if !ok {
			return BulkRequest{}, false
		}
		for key := range item {
			if key != "hex" && key != "afterId" {
				return BulkRequest{}, false
			}
		}
		hexValue, ok := requestString(item["hex"])
		if !ok {
			return BulkRequest{}, false
		}
		hexValue = strings.ToLower(strings.TrimSpace(hexValue))
		afterID, ok := safeRequestInteger(item["afterId"])
		if !ok || afterID < 1 || !ingest.IsValidAircraftID(hexValue) {
			return BulkRequest{}, false
		}
		if _, duplicate := seen[hexValue]; duplicate {
			return BulkRequest{}, false
		}
		seen[hexValue] = struct{}{}
		request.Aircraft = append(request.Aircraft, BulkAircraftRequest{Hex: hexValue, AfterID: afterID})
	}
	if detail != "" {
		if _, ok := seen[detail]; !ok {
			return BulkRequest{}, false
		}
	}
	return request, true
}

func BulkTracks(ctx context.Context, db *sql.DB, request BulkRequest, now time.Time, lookbackHours int) (BulkResponse, error) {
	if now.IsZero() {
		now = time.Now()
	}
	if lookbackHours < 1 || lookbackHours > MaxBulkLookbackHours {
		lookbackHours = MaxBulkLookbackHours
	}
	nowText := iso(now)
	cutoff := iso(now.Add(-time.Duration(lookbackHours) * time.Hour))
	valid := make(map[string]bool, len(request.Aircraft))
	validCount := 0
	for _, item := range request.Aircraft {
		var cursorHex, positionAt string
		err := db.QueryRowContext(
			ctx,
			"SELECT hex, position_at FROM track_points WHERE id = ?",
			item.AfterID,
		).Scan(&cursorHex, &positionAt)
		ok := err == nil && cursorHex == item.Hex && positionAt >= cutoff && positionAt <= nowText
		if err != nil && err != sql.ErrNoRows {
			return BulkResponse{}, err
		}
		valid[item.Hex] = ok
		if ok {
			validCount++
		}
	}
	share := 0
	if validCount > 0 {
		share = max(1, MaxBulkRows/validCount)
	}
	response := BulkResponse{Tracks: make([]BulkTrack, 0, len(request.Aircraft))}
	for _, item := range request.Aircraft {
		track := BulkTrack{
			Hex:      item.Hex,
			CursorID: item.AfterID,
			Points:   []map[string]any{},
		}
		if !valid[item.Hex] {
			track.ResetRequired = true
			response.Tracks = append(response.Tracks, track)
			continue
		}
		rows, err := queryBulkRows(ctx, db, item, cutoff, share+1, item.Hex == request.Detail)
		if err != nil {
			return BulkResponse{}, err
		}
		points, err := scanBulkRows(rows, item.Hex == request.Detail)
		if err != nil {
			return BulkResponse{}, err
		}
		track.HasMore = len(points) > share
		track.Truncated = track.HasMore
		if track.HasMore {
			points = points[:share]
		}
		track.Points = points
		if len(points) != 0 {
			track.CursorID = points[len(points)-1]["id"].(int64)
		}
		response.Tracks = append(response.Tracks, track)
	}
	return response, nil
}

func queryBulkRows(
	ctx context.Context,
	db *sql.DB,
	item BulkAircraftRequest,
	cutoff string,
	limit int,
	detail bool,
) (*sql.Rows, error) {
	columns := `
		id, position_at, lat, lon, alt_baro, alt_geom, on_ground, track
	`
	if detail {
		columns = `
			id, position_at, observed_at, lat, lon, alt_baro, alt_geom, on_ground,
			gs, ias, tas, mach, track, true_heading, mag_heading, baro_rate, geom_rate,
			wd, ws, oat, tat, source_type, messages, rssi
		`
	}
	return db.QueryContext(ctx, `
		SELECT `+columns+`
		FROM track_points
		WHERE hex = ? AND id > ? AND position_at >= ?
		ORDER BY id ASC
		LIMIT ?
	`, item.Hex, item.AfterID, cutoff, limit)
}

func scanBulkRows(rows *sql.Rows, detail bool) ([]map[string]any, error) {
	defer rows.Close()
	points := []map[string]any{}
	for rows.Next() {
		var id int64
		var positionAt string
		var lat, lon float64
		var altBaro, altGeom, track sql.NullFloat64
		var onGround int64
		if !detail {
			if err := rows.Scan(&id, &positionAt, &lat, &lon, &altBaro, &altGeom, &onGround, &track); err != nil {
				return nil, err
			}
			points = append(points, map[string]any{
				"id": id, "positionAt": positionAt, "lat": lat, "lon": lon,
				"altBaro": nullableAnyFloat(altBaro), "altGeom": nullableAnyFloat(altGeom),
				"onGround": onGround != 0, "track": nullableAnyFloat(track),
			})
			continue
		}
		var observedAt string
		var gs, ias, tas, mach, trueHeading, magHeading sql.NullFloat64
		var baroRate, geomRate, windDirection, windSpeed, oat, tat, rssi sql.NullFloat64
		var sourceType sql.NullString
		var messages sql.NullInt64
		if err := rows.Scan(
			&id, &positionAt, &observedAt, &lat, &lon, &altBaro, &altGeom, &onGround,
			&gs, &ias, &tas, &mach, &track, &trueHeading, &magHeading, &baroRate,
			&geomRate, &windDirection, &windSpeed, &oat, &tat, &sourceType, &messages, &rssi,
		); err != nil {
			return nil, err
		}
		points = append(points, map[string]any{
			"id": id, "positionAt": positionAt, "observedAt": observedAt,
			"lat": lat, "lon": lon, "altBaro": nullableAnyFloat(altBaro),
			"altGeom": nullableAnyFloat(altGeom), "onGround": onGround != 0,
			"gs": nullableAnyFloat(gs), "ias": nullableAnyFloat(ias), "tas": nullableAnyFloat(tas),
			"mach": nullableAnyFloat(mach), "track": nullableAnyFloat(track),
			"trueHeading": nullableAnyFloat(trueHeading), "magHeading": nullableAnyFloat(magHeading),
			"baroRate": nullableAnyFloat(baroRate), "geomRate": nullableAnyFloat(geomRate),
			"windDirection": nullableAnyFloat(windDirection), "windSpeed": nullableAnyFloat(windSpeed),
			"oat": nullableAnyFloat(oat), "tat": nullableAnyFloat(tat),
			"sourceType": nullableAnyString(sourceType), "messages": nullableAnyInt(messages),
			"rssi": nullableAnyFloat(rssi),
		})
	}
	return points, rows.Err()
}

func requestString(value any) (string, bool) {
	switch typed := value.(type) {
	case string:
		return typed, true
	case json.Number:
		return typed.String(), true
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64), true
	case bool:
		return strconv.FormatBool(typed), true
	default:
		return "", false
	}
}

func safeRequestInteger(value any) (int64, bool) {
	var number float64
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return 0, false
		}
		number = parsed
	case float64:
		number = typed
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err != nil {
			return 0, false
		}
		number = parsed
	default:
		return 0, false
	}
	if math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number || math.Abs(number) > 1<<53-1 {
		return 0, false
	}
	return int64(number), true
}

func nullableAnyFloat(value sql.NullFloat64) any {
	if !value.Valid {
		return nil
	}
	return value.Float64
}

func nullableAnyString(value sql.NullString) any {
	if !value.Valid {
		return nil
	}
	return value.String
}

func nullableAnyInt(value sql.NullInt64) any {
	if !value.Valid {
		return nil
	}
	return value.Int64
}
