package coverage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/luftaquila/skytrace/server/config"
	"github.com/luftaquila/skytrace/server/database"
)

const maxSegmentSteps = 24

// Coverage is evidence of local RF reception, so only positions this receiver decoded
// off the air itself qualify: adsb_icao, adsb_icao_nt, adsb_other. MLAT positions are
// computed by an aggregator network (and collide across aircraft sharing one address),
// and TIS-B/ADS-R are rebroadcasts — neither proves this antenna heard the aircraft.
const coverageSourcePattern = "adsb%"

// Beyond typical line-of-sight (~250 NM from the datum) a position only earns cells as
// part of a coherent segment pair: genuine extreme-range receptions (tropospheric
// ducting) arrive as multi-point tracks, while a CPR mis-decode is an isolated
// teleport. The first point of a far track is sacrificed to buy that distinction.
const farPointNM = 270

type Options struct {
	WindowHours                  int
	HorizontalStepNM             float64
	VerticalStepFT               float64
	CellHorizontalStepNM         float64
	CellVerticalStepFT           float64
	AggregationChunkSize         int
	HorizontalSupportNM          float64
	VerticalSupportFT            float64
	HorizontalInterpolationCells int
	HorizontalSmoothingPasses    int
	VerticalSmoothingPasses      int
	SmoothingIterations          int
	MaxCells                     int
	MaxTriangles                 int
	MaxSegmentSeconds            float64
	MaxSegmentNM                 float64
	MaxSegmentAltitudeFT         float64
	ConfigKey                    string
}

type ReceiverAggregation struct {
	ReceiverID string `json:"receiverId"`
	RawPoints  int    `json:"rawPoints"`
	CellWrites int    `json:"cellWrites"`
	Changed    bool   `json:"changed"`
	Skipped    bool   `json:"skipped"`
}

type Aggregation struct {
	Now           string                `json:"now"`
	Cutoff        string                `json:"cutoff"`
	ConfigKey     string                `json:"configKey"`
	ReceiverCount int                   `json:"receiverCount"`
	RawPoints     int                   `json:"rawPoints"`
	CellWrites    int                   `json:"cellWrites"`
	Receivers     []ReceiverAggregation `json:"receivers"`
}

type Area struct {
	ReceiverName string  `json:"receiverName"`
	Count        int     `json:"count"`
	MaxAltitude  float64 `json:"maxAltitude"`
	LastSeenAt   string  `json:"lastSeenAt"`
	VolumeMesh   *Mesh   `json:"volumeMesh"`
}

type SnapshotAggregation struct {
	Type                 string  `json:"type"`
	CellHorizontalStepNM float64 `json:"cellHorizontalStepNm"`
	CellVerticalStepFT   float64 `json:"cellVerticalStepFt"`
	ActiveCells          int     `json:"activeCells"`
}

type Snapshot struct {
	From          string              `json:"from"`
	To            string              `json:"to"`
	WindowHours   int                 `json:"windowHours"`
	WindowDays    float64             `json:"windowDays"`
	Type          string              `json:"type"`
	Count         int                 `json:"count"`
	ReceiverCount int                 `json:"receiverCount"`
	Bounds        *[2][2]float64      `json:"bounds"`
	Areas         []Area              `json:"areas"`
	Points        []any               `json:"points"`
	Aggregation   SnapshotAggregation `json:"aggregation"`
}

type partialSnapshot struct {
	count  int
	bounds *[2][2]float64
	areas  []Area
}

type receiverCacheEntry struct {
	configKey         string
	receiverSignature string
	partial           partialSnapshot
}

type ReceiverCache map[string]receiverCacheEntry

type receiverRow struct {
	id         string
	publicName sql.NullString
	lat        sql.NullFloat64
	lon        sql.NullFloat64
}

type receiverState struct {
	receiverID string
	origin     Origin
	cosLat     float64
	lastTrack  int64
	rebuilt    bool
}

type trackPoint struct {
	id         int64
	hex        string
	positionAt string
	lat        float64
	lon        float64
	altitude   float64
	time       time.Time
	valid      bool
}

type coverageCell struct {
	x, y, z  int64
	lat, lon float64
	altitude float64
	lastSeen string
	hitCount int
}

func OptionsFromConfig(cfg config.Config) Options {
	return NormalizeOptions(Options{
		WindowHours:                  cfg.CoverageWindowHours,
		HorizontalStepNM:             cfg.CoverageHorizontalStepNM,
		VerticalStepFT:               cfg.CoverageVerticalStepFT,
		CellHorizontalStepNM:         cfg.CoverageCellHorizontalStepNM,
		CellVerticalStepFT:           cfg.CoverageCellVerticalStepFT,
		AggregationChunkSize:         cfg.CoverageAggregationChunkSize,
		HorizontalSupportNM:          cfg.CoverageHorizontalSupportNM,
		VerticalSupportFT:            cfg.CoverageVerticalSupportFT,
		HorizontalInterpolationCells: cfg.CoverageHorizontalInterpolationCells,
		HorizontalSmoothingPasses:    cfg.CoverageHorizontalSmoothingPasses,
		VerticalSmoothingPasses:      cfg.CoverageVerticalSmoothingPasses,
		SmoothingIterations:          cfg.CoverageSmoothingIterations,
		MaxCells:                     cfg.CoverageMaxCells,
		MaxTriangles:                 cfg.CoverageMaxTriangles,
	})
}

func NormalizeOptions(raw Options) Options {
	raw.WindowHours = maxInt(1, defaultInt(raw.WindowHours, 24*30))
	raw.HorizontalStepNM = maxFloat(0.75, defaultFloat(raw.HorizontalStepNM, 2))
	raw.VerticalStepFT = maxFloat(250, defaultFloat(raw.VerticalStepFT, 800))
	raw.CellHorizontalStepNM = maxFloat(0.25, defaultFloat(raw.CellHorizontalStepNM, raw.HorizontalStepNM/2))
	raw.CellVerticalStepFT = maxFloat(100, defaultFloat(raw.CellVerticalStepFT, raw.VerticalStepFT/2))
	raw.MaxSegmentSeconds = maxFloat(15, defaultFloat(raw.MaxSegmentSeconds, 90))
	raw.MaxSegmentNM = maxFloat(2, defaultFloat(raw.MaxSegmentNM, 15))
	raw.MaxSegmentAltitudeFT = maxFloat(1000, defaultFloat(raw.MaxSegmentAltitudeFT, 6000))
	raw.AggregationChunkSize = clampInt(defaultInt(raw.AggregationChunkSize, 5000), 100, 50000)
	raw.HorizontalSupportNM = defaultFloat(raw.HorizontalSupportNM, 4.5)
	raw.VerticalSupportFT = defaultFloat(raw.VerticalSupportFT, 2500)
	raw.MaxCells = defaultInt(raw.MaxCells, 1200000)
	raw.MaxTriangles = defaultInt(raw.MaxTriangles, 200000)
	type configIdentity struct {
		WindowHours        int     `json:"coverageWindowHours"`
		CellHorizontalStep float64 `json:"cellHorizontalStepNm"`
		CellVerticalStep   float64 `json:"cellVerticalStepFt"`
		MaxSegmentSeconds  float64 `json:"maxSegmentSeconds"`
		MaxSegmentNM       float64 `json:"maxSegmentNm"`
		MaxSegmentAltitude float64 `json:"maxSegmentAltitudeFt"`
		MaxSegmentSteps    int     `json:"maxSegmentSteps"`
		DatumDegrees       float64 `json:"datumDegrees"`
		SourcePattern      string  `json:"sourcePattern"`
		FarPointNM         float64 `json:"farPointNm"`
	}
	identity, _ := json.Marshal(configIdentity{
		WindowHours:        raw.WindowHours,
		CellHorizontalStep: raw.CellHorizontalStepNM,
		CellVerticalStep:   raw.CellVerticalStepFT,
		MaxSegmentSeconds:  raw.MaxSegmentSeconds,
		MaxSegmentNM:       raw.MaxSegmentNM,
		MaxSegmentAltitude: raw.MaxSegmentAltitudeFT,
		MaxSegmentSteps:    maxSegmentSteps,
		DatumDegrees:       0.5,
		SourcePattern:      coverageSourcePattern,
		FarPointNM:         farPointNM,
	})
	sum := sha256.Sum256(identity)
	raw.ConfigKey = hex.EncodeToString(sum[:])
	return raw
}

func SnapDatum(lat, lon float64) Origin {
	snappedLat := clamp(jsRound(lat*2)/2, -90, 90)
	roundedLon := jsRound(lon*2) / 2
	snappedLon := math.Mod(math.Mod(roundedLon+180, 360)+360, 360) - 180
	return Origin{Lat: snappedLat, Lon: snappedLon}
}

func Refresh(ctx context.Context, db *sql.DB, raw Options, now time.Time, cache ReceiverCache) (Snapshot, Aggregation, error) {
	options := NormalizeOptions(raw)
	now = now.UTC()
	aggregation, err := SyncCells(ctx, db, options, now)
	if err != nil {
		return Snapshot{}, Aggregation{}, err
	}
	snapshot, err := BuildFromCells(ctx, db, options, now, aggregation, cache)
	return snapshot, aggregation, err
}

func SyncCells(ctx context.Context, db *sql.DB, raw Options, now time.Time) (Aggregation, error) {
	options := NormalizeOptions(raw)
	nowISO := database.ISOTime(now)
	cutoffISO := database.ISOTime(now.Add(-time.Duration(options.WindowHours) * time.Hour))
	expired := make(map[string]struct{})
	rows, err := db.QueryContext(ctx, `
		SELECT DISTINCT receiver_id
		FROM coverage_cells
		WHERE last_seen_at < ?
	`, cutoffISO)
	if err != nil {
		return Aggregation{}, err
	}
	for rows.Next() {
		var receiverID string
		if err := rows.Scan(&receiverID); err != nil {
			rows.Close()
			return Aggregation{}, err
		}
		expired[receiverID] = struct{}{}
	}
	if err := rows.Close(); err != nil {
		return Aggregation{}, err
	}
	transaction, release, err := database.WriteTx(ctx, db, "coverage.expire")
	if err != nil {
		return Aggregation{}, err
	}
	if _, err = transaction.ExecContext(ctx, "DELETE FROM coverage_cells WHERE last_seen_at < ?", cutoffISO); err == nil {
		_, err = transaction.ExecContext(ctx, "DELETE FROM coverage_track_state WHERE position_at < ?", cutoffISO)
	}
	if err != nil {
		transaction.Rollback()
		release()
		return Aggregation{}, err
	}
	// Released as soon as the transaction ends: the receiver sync below is the long
	// part of a refresh and must not hold the write lock while it runs.
	commitErr := transaction.Commit()
	release()
	if commitErr != nil {
		return Aggregation{}, commitErr
	}

	receiverRows, err := db.QueryContext(ctx, `
		SELECT r.id, r.public_name, r.lat, r.lon
		FROM receivers r
		JOIN (
			SELECT DISTINCT receiver_id
			FROM track_points
			WHERE position_at >= ? AND position_at <= ?
		) active ON active.receiver_id = r.id
		ORDER BY r.id
	`, cutoffISO, nowISO)
	if err != nil {
		return Aggregation{}, err
	}
	var receivers []receiverRow
	for receiverRows.Next() {
		var receiver receiverRow
		if err := receiverRows.Scan(&receiver.id, &receiver.publicName, &receiver.lat, &receiver.lon); err != nil {
			receiverRows.Close()
			return Aggregation{}, err
		}
		receivers = append(receivers, receiver)
	}
	if err := receiverRows.Close(); err != nil {
		return Aggregation{}, err
	}

	result := Aggregation{
		Now:           nowISO,
		Cutoff:        cutoffISO,
		ConfigKey:     options.ConfigKey,
		ReceiverCount: len(receivers),
		Receivers:     make([]ReceiverAggregation, 0, len(receivers)),
	}
	for _, receiver := range receivers {
		stats, syncErr := syncReceiver(ctx, db, receiver, cutoffISO, nowISO, options)
		if syncErr != nil {
			return Aggregation{}, syncErr
		}
		if _, wasExpired := expired[receiver.id]; wasExpired {
			stats.Changed = true
		}
		result.RawPoints += stats.RawPoints
		result.CellWrites += stats.CellWrites
		result.Receivers = append(result.Receivers, stats)
	}
	return result, nil
}

func ensureReceiverState(
	ctx context.Context,
	db *sql.DB,
	receiver receiverRow,
	cutoffISO, nowISO string,
	options Options,
) (*receiverState, error) {
	var currentKey string
	var currentLat, currentLon float64
	var lastTrack int64
	err := db.QueryRowContext(ctx, `
		SELECT config_key, origin_lat, origin_lon, last_track_id
		FROM coverage_receiver_state
		WHERE receiver_id = ?
	`, receiver.id).Scan(&currentKey, &currentLat, &currentLon, &lastTrack)
	hasCurrent := err == nil
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	var configured *Origin
	if receiver.lat.Valid && receiver.lon.Valid {
		value := SnapDatum(receiver.lat.Float64, receiver.lon.Float64)
		configured = &value
	}
	originChanged := configured != nil && hasCurrent &&
		(math.Abs(configured.Lat-currentLat) > 1e-7 || math.Abs(configured.Lon-currentLon) > 1e-7)
	if hasCurrent && currentKey == options.ConfigKey && !originChanged {
		cosLat := math.Cos(currentLat * math.Pi / 180)
		if cosLat == 0 {
			cosLat = 1e-6
		}
		return &receiverState{
			receiverID: receiver.id,
			origin:     Origin{Lat: currentLat, Lon: currentLon},
			cosLat:     cosLat,
			lastTrack:  lastTrack,
		}, nil
	}

	var origin Origin
	switch {
	case configured != nil:
		origin = *configured
	case hasCurrent:
		origin = Origin{Lat: currentLat, Lon: currentLon}
	default:
		var lat, lon float64
		err := db.QueryRowContext(ctx, `
			SELECT lat, lon
			FROM track_points
			WHERE receiver_id = ? AND position_at >= ? AND position_at <= ?
				AND lat IS NOT NULL AND lon IS NOT NULL
				AND source_type LIKE '`+coverageSourcePattern+`'
			ORDER BY position_at ASC, id ASC
			LIMIT 1
		`, receiver.id, cutoffISO, nowISO).Scan(&lat, &lon)
		if err == sql.ErrNoRows {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		origin = SnapDatum(lat, lon)
	}
	var firstActive sql.NullInt64
	if err := db.QueryRowContext(ctx, `
		SELECT MIN(id)
		FROM track_points
		WHERE receiver_id = ? AND position_at >= ? AND position_at <= ?
	`, receiver.id, cutoffISO, nowISO).Scan(&firstActive); err != nil {
		return nil, err
	}
	lastTrack = 0
	if firstActive.Valid && firstActive.Int64 > 0 {
		lastTrack = firstActive.Int64 - 1
	}
	transaction, release, err := database.WriteTx(ctx, db, "coverage.rebuild")
	if err != nil {
		return nil, err
	}
	defer release()
	for _, statement := range []string{
		"DELETE FROM coverage_cells WHERE receiver_id = ?",
		"DELETE FROM coverage_track_state WHERE receiver_id = ?",
	} {
		if _, err := transaction.ExecContext(ctx, statement, receiver.id); err != nil {
			transaction.Rollback()
			return nil, err
		}
	}
	if _, err := transaction.ExecContext(ctx, `
		INSERT INTO coverage_receiver_state (
			receiver_id, config_key, origin_lat, origin_lon, last_track_id, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(receiver_id) DO UPDATE SET
			config_key = excluded.config_key,
			origin_lat = excluded.origin_lat,
			origin_lon = excluded.origin_lon,
			last_track_id = excluded.last_track_id,
			updated_at = excluded.updated_at
	`, receiver.id, options.ConfigKey, origin.Lat, origin.Lon, lastTrack, nowISO); err != nil {
		transaction.Rollback()
		return nil, err
	}
	if err := transaction.Commit(); err != nil {
		return nil, err
	}
	cosLat := math.Cos(origin.Lat * math.Pi / 180)
	if cosLat == 0 {
		cosLat = 1e-6
	}
	return &receiverState{
		receiverID: receiver.id,
		origin:     origin,
		cosLat:     cosLat,
		lastTrack:  lastTrack,
		rebuilt:    true,
	}, nil
}

func syncReceiver(
	ctx context.Context,
	db *sql.DB,
	receiver receiverRow,
	cutoffISO, nowISO string,
	options Options,
) (ReceiverAggregation, error) {
	stats := ReceiverAggregation{ReceiverID: receiver.id}
	state, err := ensureReceiverState(ctx, db, receiver, cutoffISO, nowISO, options)
	if err != nil {
		return stats, err
	}
	if state == nil {
		stats.Skipped = true
		return stats, nil
	}
	stats.Changed = state.rebuilt
	var target sql.NullInt64
	if err := db.QueryRowContext(ctx, `
		SELECT MAX(id)
		FROM track_points
		WHERE receiver_id = ? AND position_at >= ? AND position_at <= ?
	`, receiver.id, cutoffISO, nowISO).Scan(&target); err != nil {
		return stats, err
	}
	targetTrack := state.lastTrack
	if target.Valid {
		targetTrack = target.Int64
	}
	if state.lastTrack >= targetTrack {
		return stats, nil
	}
	trackState, err := loadTrackState(ctx, db, receiver.id)
	if err != nil {
		return stats, err
	}
	cursor := state.lastTrack
	for cursor < targetTrack {
		rows, queryErr := db.QueryContext(ctx, `
			SELECT id, hex, position_at, lat, lon, alt_baro, alt_geom
			FROM track_points
			WHERE receiver_id = ?
				AND id > ?
				AND id <= ?
				AND position_at >= ?
				AND position_at <= ?
				AND lat IS NOT NULL
				AND lon IS NOT NULL
				AND source_type LIKE '`+coverageSourcePattern+`'
			ORDER BY id ASC
			LIMIT ?
		`, receiver.id, cursor, targetTrack, cutoffISO, nowISO, options.AggregationChunkSize)
		if queryErr != nil {
			return stats, queryErr
		}
		var chunk []trackPoint
		for rows.Next() {
			var point trackPoint
			var altBaro, altGeom sql.NullFloat64
			if err := rows.Scan(
				&point.id, &point.hex, &point.positionAt, &point.lat, &point.lon,
				&altBaro, &altGeom,
			); err != nil {
				rows.Close()
				return stats, err
			}
			switch {
			case altBaro.Valid:
				point.altitude = altBaro.Float64
			case altGeom.Valid:
				point.altitude = altGeom.Float64
			default:
				chunk = append(chunk, point)
				continue
			}
			parsed, parseErr := time.Parse(time.RFC3339Nano, point.positionAt)
			if parseErr != nil || point.lat < -90 || point.lat > 90 ||
				point.lon < -180 || point.lon > 180 ||
				point.altitude < 0 || point.altitude > 80000 {
				chunk = append(chunk, point)
				continue
			}
			point.time = parsed
			point.valid = true
			chunk = append(chunk, point)
		}
		if err := rows.Close(); err != nil {
			return stats, err
		}
		if len(chunk) == 0 {
			if err := persistChunk(ctx, db, state, nil, nil, targetTrack, options, nowISO); err != nil {
				return stats, err
			}
			break
		}
		cells := make(map[[3]int64]*coverageCell)
		touched := make(map[string]trackPoint)
		for _, point := range chunk {
			if point.id > cursor {
				cursor = point.id
			}
			if !point.valid {
				continue
			}
			previous, hasPrevious := trackState[point.hex]
			addPointAndSegment(cells, previous, hasPrevious, point, state, options)
			if !hasPrevious || point.time.After(previous.time) {
				trackState[point.hex] = point
				touched[point.hex] = point
			}
			stats.RawPoints++
		}
		persistedCursor := cursor
		if len(chunk) < options.AggregationChunkSize {
			persistedCursor = targetTrack
		}
		if err := persistChunk(ctx, db, state, cells, touched, persistedCursor, options, nowISO); err != nil {
			return stats, err
		}
		stats.CellWrites += len(cells)
		cursor = persistedCursor
	}
	stats.Changed = stats.Changed || stats.RawPoints > 0
	return stats, nil
}

func loadTrackState(ctx context.Context, db *sql.DB, receiverID string) (map[string]trackPoint, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT hex, position_at, lat, lon, altitude_ft
		FROM coverage_track_state
		WHERE receiver_id = ?
	`, receiverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]trackPoint)
	for rows.Next() {
		var point trackPoint
		if err := rows.Scan(&point.hex, &point.positionAt, &point.lat, &point.lon, &point.altitude); err != nil {
			return nil, err
		}
		parsed, err := time.Parse(time.RFC3339Nano, point.positionAt)
		if err != nil {
			continue
		}
		point.time = parsed
		point.valid = true
		result[point.hex] = point
	}
	return result, rows.Err()
}

func addPointAndSegment(
	cells map[[3]int64]*coverageCell,
	previous trackPoint,
	hasPrevious bool,
	point trackPoint,
	state *receiverState,
	options Options,
) {
	east, north := localCoordinates(point, state)
	var horizontalNM, altitudeDelta float64
	coherent := false
	if hasPrevious {
		dtSeconds := point.time.Sub(previous.time).Seconds()
		if dtSeconds > 0 && dtSeconds <= options.MaxSegmentSeconds {
			previousEast, previousNorth := localCoordinates(previous, state)
			horizontalNM = math.Hypot(east-previousEast, north-previousNorth)
			altitudeDelta = math.Abs(point.altitude - previous.altitude)
			coherent = horizontalNM <= options.MaxSegmentNM && altitudeDelta <= options.MaxSegmentAltitudeFT
		}
	}
	if !coherent && math.Hypot(east, north) > farPointNM {
		// The caller still records the point in track state, so a genuine far track
		// earns cells from its second point on.
		return
	}
	addCell(cells, point, state, options)
	if !coherent {
		return
	}
	steps := minInt(maxSegmentSteps, int(math.Ceil(maxFloat(
		horizontalNM/(options.CellHorizontalStepNM*0.75),
		altitudeDelta/(options.CellVerticalStepFT*0.75),
	))))
	for step := 1; step < steps; step++ {
		fraction := float64(step) / float64(steps)
		interpolated := trackPoint{
			lat:        previous.lat + (point.lat-previous.lat)*fraction,
			lon:        previous.lon + (point.lon-previous.lon)*fraction,
			altitude:   previous.altitude + (point.altitude-previous.altitude)*fraction,
			positionAt: point.positionAt,
			time:       previous.time.Add(time.Duration(float64(point.time.Sub(previous.time)) * fraction)),
		}
		addCell(cells, interpolated, state, options)
	}
}

func localCoordinates(point trackPoint, state *receiverState) (float64, float64) {
	return (point.lon - state.origin.Lon) * state.cosLat * 60,
		(point.lat - state.origin.Lat) * 60
}

func addCell(cells map[[3]int64]*coverageCell, point trackPoint, state *receiverState, options Options) {
	east, north := localCoordinates(point, state)
	cellX := int64(jsRound(east / options.CellHorizontalStepNM))
	cellY := int64(jsRound(north / options.CellHorizontalStepNM))
	cellZ := int64(jsRound(point.altitude / options.CellVerticalStepFT))
	key := [3]int64{cellX, cellY, cellZ}
	if existing := cells[key]; existing != nil {
		existing.hitCount++
		if point.positionAt > existing.lastSeen {
			existing.lastSeen = point.positionAt
		}
		return
	}
	east = float64(cellX) * options.CellHorizontalStepNM
	north = float64(cellY) * options.CellHorizontalStepNM
	cells[key] = &coverageCell{
		x:        cellX,
		y:        cellY,
		z:        cellZ,
		lat:      state.origin.Lat + north/60,
		lon:      state.origin.Lon + east/state.cosLat/60,
		altitude: float64(cellZ) * options.CellVerticalStepFT,
		lastSeen: point.positionAt,
		hitCount: 1,
	}
}

func persistChunk(
	ctx context.Context,
	db *sql.DB,
	state *receiverState,
	cells map[[3]int64]*coverageCell,
	tracks map[string]trackPoint,
	cursor int64,
	options Options,
	nowISO string,
) error {
	transaction, release, err := database.WriteTx(ctx, db, "coverage.chunk")
	if err != nil {
		return err
	}
	defer release()
	for _, cell := range cells {
		if _, err := transaction.ExecContext(ctx, `
			INSERT INTO coverage_cells (
				receiver_id, config_key, cell_x, cell_y, cell_z,
				lat, lon, altitude_ft, last_seen_at, hit_count
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(receiver_id, config_key, cell_x, cell_y, cell_z) DO UPDATE SET
				last_seen_at = CASE
					WHEN excluded.last_seen_at > coverage_cells.last_seen_at
					THEN excluded.last_seen_at
					ELSE coverage_cells.last_seen_at
				END,
				hit_count = coverage_cells.hit_count + excluded.hit_count
		`, state.receiverID, options.ConfigKey, cell.x, cell.y, cell.z,
			cell.lat, cell.lon, cell.altitude, cell.lastSeen, cell.hitCount); err != nil {
			transaction.Rollback()
			return err
		}
	}
	for hex, point := range tracks {
		if _, err := transaction.ExecContext(ctx, `
			INSERT INTO coverage_track_state (
				receiver_id, hex, position_at, lat, lon, altitude_ft
			)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(receiver_id, hex) DO UPDATE SET
				position_at = excluded.position_at,
				lat = excluded.lat,
				lon = excluded.lon,
				altitude_ft = excluded.altitude_ft
			WHERE excluded.position_at > coverage_track_state.position_at
		`, state.receiverID, hex, point.positionAt, point.lat, point.lon, point.altitude); err != nil {
			transaction.Rollback()
			return err
		}
	}
	if _, err := transaction.ExecContext(ctx, `
		UPDATE coverage_receiver_state
		SET last_track_id = ?, updated_at = ?
		WHERE receiver_id = ? AND config_key = ?
	`, cursor, nowISO, state.receiverID, options.ConfigKey); err != nil {
		transaction.Rollback()
		return err
	}
	return transaction.Commit()
}

func BuildFromCells(
	ctx context.Context,
	db *sql.DB,
	raw Options,
	now time.Time,
	aggregation Aggregation,
	cache ReceiverCache,
) (Snapshot, error) {
	options := NormalizeOptions(raw)
	nowISO := database.ISOTime(now)
	cutoffISO := database.ISOTime(now.Add(-time.Duration(options.WindowHours) * time.Hour))
	rows, err := db.QueryContext(ctx, `
		SELECT
			s.receiver_id,
			r.public_name,
			r.lat,
			r.lon
		FROM coverage_receiver_state s
		JOIN receivers r ON r.id = s.receiver_id
		JOIN coverage_cells c
			ON c.receiver_id = s.receiver_id
			AND c.config_key = s.config_key
		WHERE s.config_key = ?
			AND c.last_seen_at >= ?
			AND c.last_seen_at <= ?
		GROUP BY s.receiver_id
		ORDER BY s.receiver_id
	`, options.ConfigKey, cutoffISO, nowISO)
	if err != nil {
		return Snapshot{}, err
	}
	var receivers []receiverRow
	for rows.Next() {
		var receiver receiverRow
		if err := rows.Scan(&receiver.id, &receiver.publicName, &receiver.lat, &receiver.lon); err != nil {
			rows.Close()
			return Snapshot{}, err
		}
		receivers = append(receivers, receiver)
	}
	if err := rows.Close(); err != nil {
		return Snapshot{}, err
	}
	stats := make(map[string]ReceiverAggregation)
	for _, item := range aggregation.Receivers {
		stats[item.ReceiverID] = item
	}
	active := make(map[string]struct{})
	snapshot := Snapshot{
		From:          cutoffISO,
		To:            nowISO,
		WindowHours:   options.WindowHours,
		WindowDays:    round(float64(options.WindowHours)/24, 2),
		Type:          "observed-occupancy",
		ReceiverCount: len(receivers),
		Areas:         make([]Area, 0, len(receivers)),
		Points:        []any{},
		Aggregation: SnapshotAggregation{
			Type:                 "receiver-spatial-cells",
			CellHorizontalStepNM: options.CellHorizontalStepNM,
			CellVerticalStepFT:   options.CellVerticalStepFT,
		},
	}
	for _, receiver := range receivers {
		active[receiver.id] = struct{}{}
		signatureBytes, _ := json.Marshal([]any{
			nullString(receiver.publicName, receiver.id),
			nullFloat(receiver.lat),
			nullFloat(receiver.lon),
		})
		signature := string(signatureBytes)
		cached, hasCached := cache[receiver.id]
		receiverStats := stats[receiver.id]
		var partial partialSnapshot
		if hasCached && cached.configKey == options.ConfigKey &&
			cached.receiverSignature == signature && !receiverStats.Changed {
			partial = cached.partial
		} else {
			partial, err = buildReceiverPartial(ctx, db, receiver, options, cutoffISO, nowISO)
			if err != nil {
				return Snapshot{}, err
			}
			if cache != nil {
				cache[receiver.id] = receiverCacheEntry{
					configKey: options.ConfigKey, receiverSignature: signature, partial: partial,
				}
			}
		}
		snapshot.Count += partial.count
		snapshot.Aggregation.ActiveCells += partial.count
		snapshot.Bounds = mergeBounds(snapshot.Bounds, partial.bounds)
		snapshot.Areas = append(snapshot.Areas, partial.areas...)
	}
	for receiverID := range cache {
		if _, exists := active[receiverID]; !exists {
			delete(cache, receiverID)
		}
	}
	sort.SliceStable(snapshot.Areas, func(i, j int) bool {
		return snapshot.Areas[i].Count > snapshot.Areas[j].Count
	})
	return snapshot, nil
}

func buildReceiverPartial(
	ctx context.Context,
	db *sql.DB,
	receiver receiverRow,
	options Options,
	cutoffISO, nowISO string,
) (partialSnapshot, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT c.last_seen_at, c.lat, c.lon, c.altitude_ft
		FROM coverage_cells c
		WHERE c.receiver_id = ?
			AND c.config_key = ?
			AND c.last_seen_at >= ?
			AND c.last_seen_at <= ?
		ORDER BY c.cell_z, c.cell_y, c.cell_x
	`, receiver.id, options.ConfigKey, cutoffISO, nowISO)
	if err != nil {
		return partialSnapshot{}, err
	}
	var volumeRows []VolumeRow
	var bounds *[2][2]float64
	maxAltitude := math.Inf(-1)
	lastSeen := ""
	var latSum, lonSum float64
	for rows.Next() {
		var row VolumeRow
		if err := rows.Scan(&row.PositionAt, &row.Lat, &row.Lon, &row.AltitudeFT); err != nil {
			rows.Close()
			return partialSnapshot{}, err
		}
		volumeRows = append(volumeRows, row)
		latSum += row.Lat
		lonSum += row.Lon
		maxAltitude = maxFloat(maxAltitude, row.AltitudeFT)
		if row.PositionAt > lastSeen {
			lastSeen = row.PositionAt
		}
		if bounds == nil {
			bounds = &[2][2]float64{{row.Lat, row.Lon}, {row.Lat, row.Lon}}
		} else {
			bounds[0][0] = minFloat(bounds[0][0], row.Lat)
			bounds[0][1] = minFloat(bounds[0][1], row.Lon)
			bounds[1][0] = maxFloat(bounds[1][0], row.Lat)
			bounds[1][1] = maxFloat(bounds[1][1], row.Lon)
		}
	}
	if err := rows.Close(); err != nil {
		return partialSnapshot{}, err
	}
	if len(volumeRows) == 0 {
		return partialSnapshot{}, nil
	}
	for axis := 0; axis < 2; axis++ {
		bounds[axis][0] = round(bounds[axis][0], 6)
		bounds[axis][1] = round(bounds[axis][1], 6)
	}
	mesh, err := BuildObservedCoverageMesh(
		volumeRows,
		Origin{Lat: latSum / float64(len(volumeRows)), Lon: lonSum / float64(len(volumeRows))},
		VolumeOptions{
			HorizontalStepNM:             options.HorizontalStepNM,
			VerticalStepFT:               options.VerticalStepFT,
			HorizontalSupportNM:          options.HorizontalSupportNM,
			VerticalSupportFT:            options.VerticalSupportFT,
			HorizontalInterpolationCells: options.HorizontalInterpolationCells,
			HorizontalSmoothingPasses:    options.HorizontalSmoothingPasses,
			VerticalSmoothingPasses:      options.VerticalSmoothingPasses,
			SmoothingIterations:          options.SmoothingIterations,
			MaxCells:                     options.MaxCells,
			MaxTriangles:                 options.MaxTriangles,
			ExplicitPostProcessing:       true,
		},
	)
	if err != nil {
		return partialSnapshot{}, err
	}
	return partialSnapshot{
		count:  len(volumeRows),
		bounds: bounds,
		areas: []Area{{
			ReceiverName: nullString(receiver.publicName, receiver.id),
			Count:        len(volumeRows),
			MaxAltitude:  maxAltitude,
			LastSeenAt:   lastSeen,
			VolumeMesh:   mesh,
		}},
	}, nil
}

func mergeBounds(current, next *[2][2]float64) *[2][2]float64 {
	if next == nil {
		return current
	}
	if current == nil {
		copy := *next
		return &copy
	}
	current[0][0] = minFloat(current[0][0], next[0][0])
	current[0][1] = minFloat(current[0][1], next[0][1])
	current[1][0] = maxFloat(current[1][0], next[1][0])
	current[1][1] = maxFloat(current[1][1], next[1][1])
	return current
}

func nullString(value sql.NullString, fallback string) string {
	if value.Valid && value.String != "" {
		return value.String
	}
	return fallback
}

func nullFloat(value sql.NullFloat64) any {
	if value.Valid {
		return value.Float64
	}
	return nil
}

func ValidateConfigKeyCompatibility(options Options, expected string) error {
	if NormalizeOptions(options).ConfigKey != expected {
		return fmt.Errorf("coverage config key mismatch")
	}
	return nil
}
