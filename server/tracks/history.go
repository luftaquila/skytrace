package tracks

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/luftaquila/skytrace/server/ingest"
)

const (
	DefaultHistoryPagePoints = 2000
	MaxHistoryPagePoints     = 5000
)

type QueryError struct {
	Status  int
	Message string
}

func (err *QueryError) Error() string {
	return err.Message
}

type HistoryOptions struct {
	Limit         int
	OlderCursor   string
	At            *time.Time
	RetentionDays int
	Now           time.Time
}

type Point struct {
	ID            int64    `json:"id"`
	Hex           string   `json:"hex"`
	ReceiverID    string   `json:"receiverId"`
	ObservedAt    string   `json:"observedAt"`
	PositionAt    string   `json:"positionAt"`
	Lat           float64  `json:"lat"`
	Lon           float64  `json:"lon"`
	AltBaro       *float64 `json:"altBaro"`
	AltGeom       *float64 `json:"altGeom"`
	OnGround      bool     `json:"onGround"`
	GS            *float64 `json:"gs"`
	IAS           *float64 `json:"ias"`
	TAS           *float64 `json:"tas"`
	Mach          *float64 `json:"mach"`
	Track         *float64 `json:"track"`
	TrueHeading   *float64 `json:"trueHeading"`
	MagHeading    *float64 `json:"magHeading"`
	BaroRate      *float64 `json:"baroRate"`
	GeomRate      *float64 `json:"geomRate"`
	WindDirection *float64 `json:"windDirection"`
	WindSpeed     *float64 `json:"windSpeed"`
	OAT           *float64 `json:"oat"`
	TAT           *float64 `json:"tat"`
	SourceType    *string  `json:"sourceType"`
	Messages      *int64   `json:"messages"`
	RSSI          *float64 `json:"rssi"`
}

type History struct {
	Hex             string  `json:"hex"`
	Points          []Point `json:"points"`
	LiveCursorID    *int64  `json:"liveCursorId"`
	OlderCursor     *string `json:"olderCursor"`
	HasOlder        bool    `json:"hasOlder"`
	RetentionCutoff string  `json:"retentionCutoff"`
}

type cursor struct {
	ID  int64  `json:"id"`
	Hex string `json:"hex"`
	At  string `json:"at"`
}

func AircraftHistory(ctx context.Context, db *sql.DB, hexValue string, options HistoryOptions) (History, error) {
	hexValue = strings.ToLower(strings.TrimSpace(hexValue))
	if !ingest.IsValidAircraftID(hexValue) {
		return History{}, &QueryError{Status: 400, Message: "invalid aircraft id"}
	}
	if options.Now.IsZero() {
		options.Now = time.Now()
	}
	if options.RetentionDays < 1 {
		options.RetentionDays = 90
	}
	if options.RetentionDays > 365 {
		options.RetentionDays = 365
	}
	if options.Limit < 1 {
		options.Limit = DefaultHistoryPagePoints
	}
	if options.Limit > MaxHistoryPagePoints {
		options.Limit = MaxHistoryPagePoints
	}
	if options.OlderCursor != "" && options.At != nil {
		return History{}, &QueryError{Status: 400, Message: "olderCursor and at cannot be used together"}
	}
	nowText := iso(options.Now)
	retentionCutoff := iso(options.Now.Add(-time.Duration(options.RetentionDays) * 24 * time.Hour))
	if options.At != nil && (options.At.Before(options.Now.Add(-time.Duration(options.RetentionDays)*24*time.Hour)) || options.At.After(options.Now)) {
		return History{}, &QueryError{Status: 400, Message: "at must be within retained history"}
	}

	transaction, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return History{}, err
	}
	defer transaction.Rollback()
	var maxID sql.NullInt64
	if err := transaction.QueryRowContext(ctx, `
		SELECT MAX(id) FROM track_points
		WHERE hex = ? AND position_at >= ? AND position_at <= ?
	`, hexValue, retentionCutoff, nowText).Scan(&maxID); err != nil {
		return History{}, err
	}

	var rows *sql.Rows
	switch {
	case options.OlderCursor != "":
		decoded, ok := decodeCursor(options.OlderCursor)
		if !ok || decoded.Hex != hexValue {
			return History{}, &QueryError{Status: 400, Message: "invalid olderCursor"}
		}
		var boundaryHex, boundaryAt string
		err := transaction.QueryRowContext(
			ctx,
			"SELECT hex, position_at FROM track_points WHERE id = ?",
			decoded.ID,
		).Scan(&boundaryHex, &boundaryAt)
		if errors.Is(err, sql.ErrNoRows) {
			cursorAt, _ := time.Parse(time.RFC3339Nano, decoded.At)
			cutoffAt, _ := time.Parse(time.RFC3339Nano, retentionCutoff)
			if cursorAt.Before(cutoffAt) {
				return History{}, &QueryError{Status: 410, Message: "history cursor expired"}
			}
			return History{}, &QueryError{Status: 400, Message: "invalid olderCursor"}
		}
		if err != nil {
			return History{}, err
		}
		if boundaryHex != hexValue || boundaryAt != decoded.At {
			return History{}, &QueryError{Status: 400, Message: "invalid olderCursor"}
		}
		if boundaryAt < retentionCutoff {
			return History{}, &QueryError{Status: 410, Message: "history cursor expired"}
		}
		rows, err = queryBefore(ctx, transaction, hexValue, retentionCutoff, boundaryAt, decoded.ID, options.Limit+1)
	case options.At != nil:
		rows, err = queryBefore(ctx, transaction, hexValue, retentionCutoff, iso(*options.At), 1<<53-1, options.Limit+1)
	default:
		rows, err = queryLatest(ctx, transaction, hexValue, retentionCutoff, nowText, options.Limit+1)
	}
	if err != nil {
		return History{}, err
	}
	points, err := scanPoints(rows)
	if err != nil {
		return History{}, err
	}
	hasOlder := len(points) > options.Limit
	if hasOlder {
		points = points[:options.Limit]
	}
	var olderCursor *string
	if hasOlder && len(points) != 0 {
		value := encodeCursor(cursor{ID: points[len(points)-1].ID, Hex: points[len(points)-1].Hex, At: points[len(points)-1].PositionAt})
		olderCursor = &value
	}
	for left, right := 0, len(points)-1; left < right; left, right = left+1, right-1 {
		points[left], points[right] = points[right], points[left]
	}
	if err := transaction.Commit(); err != nil {
		return History{}, err
	}
	result := History{
		Hex:             hexValue,
		Points:          points,
		OlderCursor:     olderCursor,
		HasOlder:        hasOlder,
		RetentionCutoff: retentionCutoff,
	}
	if maxID.Valid {
		result.LiveCursorID = &maxID.Int64
	}
	return result, nil
}

func queryLatest(ctx context.Context, transaction *sql.Tx, hex, cutoff, now string, limit int) (*sql.Rows, error) {
	return transaction.QueryContext(ctx, `
		SELECT `+detailColumns+`
		FROM track_points
		WHERE hex = ? AND position_at >= ? AND position_at <= ?
		ORDER BY position_at DESC, id DESC
		LIMIT ?
	`, hex, cutoff, now, limit)
}

func queryBefore(ctx context.Context, transaction *sql.Tx, hex, cutoff, at string, id int64, limit int) (*sql.Rows, error) {
	return transaction.QueryContext(ctx, `
		SELECT `+detailColumns+`
		FROM track_points
		WHERE hex = ? AND position_at >= ?
		  AND (position_at, id) < (?, ?)
		ORDER BY position_at DESC, id DESC
		LIMIT ?
	`, hex, cutoff, at, id, limit)
}

const detailColumns = `
	id, hex, receiver_id, observed_at, position_at, lat, lon, alt_baro,
	alt_geom, on_ground, gs, ias, tas, mach, track, true_heading,
	mag_heading, baro_rate, geom_rate, wd, ws, oat, tat,
	source_type, messages, rssi
`

func scanPoints(rows *sql.Rows) ([]Point, error) {
	defer rows.Close()
	points := []Point{}
	for rows.Next() {
		var point Point
		var altBaro, altGeom, gs, ias, tas, mach, track sql.NullFloat64
		var trueHeading, magHeading, baroRate, geomRate sql.NullFloat64
		var windDirection, windSpeed, oat, tat, rssi sql.NullFloat64
		var sourceType sql.NullString
		var messages sql.NullInt64
		var onGround int64
		if err := rows.Scan(
			&point.ID, &point.Hex, &point.ReceiverID, &point.ObservedAt, &point.PositionAt,
			&point.Lat, &point.Lon, &altBaro, &altGeom, &onGround, &gs, &ias, &tas, &mach,
			&track, &trueHeading, &magHeading, &baroRate, &geomRate, &windDirection,
			&windSpeed, &oat, &tat, &sourceType, &messages, &rssi,
		); err != nil {
			return nil, err
		}
		point.AltBaro = nullableFloat(altBaro)
		point.AltGeom = nullableFloat(altGeom)
		point.OnGround = onGround != 0
		point.GS = nullableFloat(gs)
		point.IAS = nullableFloat(ias)
		point.TAS = nullableFloat(tas)
		point.Mach = nullableFloat(mach)
		point.Track = nullableFloat(track)
		point.TrueHeading = nullableFloat(trueHeading)
		point.MagHeading = nullableFloat(magHeading)
		point.BaroRate = nullableFloat(baroRate)
		point.GeomRate = nullableFloat(geomRate)
		point.WindDirection = nullableFloat(windDirection)
		point.WindSpeed = nullableFloat(windSpeed)
		point.OAT = nullableFloat(oat)
		point.TAT = nullableFloat(tat)
		point.SourceType = stringPointer(sourceType)
		point.Messages = intPointer(messages)
		point.RSSI = nullableFloat(rssi)
		points = append(points, point)
	}
	return points, rows.Err()
}

func encodeCursor(value cursor) string {
	bytes, _ := json.Marshal(value)
	return base64.RawURLEncoding.EncodeToString(bytes)
}

func decodeCursor(value string) (cursor, bool) {
	if value == "" || len(value) > 256 {
		return cursor{}, false
	}
	bytes, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return cursor{}, false
	}
	var decoded cursor
	if err := json.Unmarshal(bytes, &decoded); err != nil ||
		decoded.ID < 1 ||
		!ingest.IsValidAircraftID(decoded.Hex) {
		return cursor{}, false
	}
	if _, err := time.Parse(time.RFC3339Nano, decoded.At); err != nil {
		return cursor{}, false
	}
	if encodeCursor(decoded) != value {
		return cursor{}, false
	}
	return decoded, true
}

func nullableFloat(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	return &value.Float64
}

func TrackKML(hexValue string, points []Point) string {
	replacer := strings.NewReplacer("<", "", ">", "", "&", "", "'", "", `"`, "")
	safeHex := replacer.Replace(hexValue)
	coordinates := make([]string, 0, len(points))
	for _, point := range points {
		altitude := float64(0)
		if point.AltGeom != nil {
			altitude = *point.AltGeom
		} else if point.AltBaro != nil {
			altitude = *point.AltBaro
		}
		coordinates = append(coordinates, fmt.Sprintf("%v,%v,%v", point.Lon, point.Lat, altitude))
	}
	upper := strings.ToUpper(safeHex)
	return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Skytrace ` + upper + ` track</name>
    <Placemark>
      <name>` + upper + `</name>
      <Style><LineStyle><color>ff24bffb</color><width>3</width></LineStyle></Style>
      <LineString>
        <tessellate>1</tessellate>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>` + strings.Join(coordinates, " ") + `</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>
`
}
