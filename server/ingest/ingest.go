package ingest

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/luftaquila/skytrace/server/database"
)

const (
	maxIngestAircraft          = 1000
	maxReceiverCurrentAircraft = 20000
)

type AuthResult struct {
	OK         bool
	Reason     string
	ReceiverID string
	TokenHash  string
}

type Options struct {
	ReceiverID               string
	TokenHash                string
	ReceivedAt               time.Time
	RemoteAddr               string
	UserAgent                string
	MaxObservationAgeSeconds float64
	TrackMinIntervalSeconds  float64
	PositionFilterMaxMach    float64
	ConsumeTrackBudget       func(string) bool
}

type Result struct {
	ReceiverID                  string   `json:"receiverId"`
	BatchID                     int64    `json:"batchId"`
	ReceivedAt                  string   `json:"receivedAt"`
	SourceNow                   *string  `json:"sourceNow"`
	AircraftCount               int      `json:"aircraftCount"`
	TruncatedCount              int      `json:"truncatedCount"`
	AcceptedCount               int      `json:"acceptedCount"`
	InvalidObservationCount     int      `json:"invalidObservationCount"`
	InvalidFieldCount           int      `json:"invalidFieldCount"`
	TruncatedFieldCount         int      `json:"truncatedFieldCount"`
	FilteredPositionCount       int      `json:"filteredPositionCount"`
	CurrentCapacityDroppedCount int      `json:"currentCapacityDroppedCount"`
	TrackBudgetDroppedCount     int      `json:"trackBudgetDroppedCount"`
	TrackPoints                 int      `json:"trackPoints"`
	ChangedHexes                []string `json:"changedHexes"`
}

func DecodePayload(bytes []byte) (map[string]any, error) {
	decoder := json.NewDecoder(strings.NewReader(string(bytes)))
	decoder.UseNumber()
	var payload map[string]any
	if err := decoder.Decode(&payload); err != nil {
		return nil, err
	}
	if payload == nil {
		payload = map[string]any{}
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("multiple JSON values")
	}
	return payload, nil
}

func Authenticate(ctx context.Context, db *sql.DB, token, receiverID string) (AuthResult, error) {
	if token == "" {
		return AuthResult{Reason: "missing token"}, nil
	}
	hash := database.HashToken(token)
	var configuredReceiver string
	err := db.QueryRowContext(
		ctx,
		"SELECT receiver_id FROM receiver_tokens WHERE token_hash = ?",
		hash,
	).Scan(&configuredReceiver)
	if errors.Is(err, sql.ErrNoRows) {
		return AuthResult{Reason: "invalid token"}, nil
	}
	if err != nil {
		return AuthResult{}, err
	}
	if receiverID != "" && configuredReceiver != receiverID {
		return AuthResult{Reason: "invalid token"}, nil
	}
	return AuthResult{
		OK:         true,
		ReceiverID: configuredReceiver,
		TokenHash:  hash,
	}, nil
}

func Store(ctx context.Context, db *sql.DB, payload map[string]any, options Options) (Result, error) {
	receiverID, ok := SanitizeReceiverID(options.ReceiverID)
	if !ok {
		return Result{}, errors.New("receiver id is required")
	}
	if options.ReceivedAt.IsZero() {
		options.ReceivedAt = time.Now()
	}
	if !isFinite(options.MaxObservationAgeSeconds) {
		options.MaxObservationAgeSeconds = 120
	}
	if !isFinite(options.PositionFilterMaxMach) || options.PositionFilterMaxMach == 0 {
		options.PositionFilterMaxMach = 3.5
	}
	receivedAt := iso(options.ReceivedAt)
	aircraftPayload, rawAircraft := selectedAircraftPayload(payload)
	boundedAircraft := rawAircraft
	if len(boundedAircraft) > maxIngestAircraft {
		boundedAircraft = boundedAircraft[:maxIngestAircraft]
	}
	aircraftPayload["aircraft"] = boundedAircraft
	normalized := NormalizePayload(aircraftPayload, options.ReceivedAt, options.MaxObservationAgeSeconds)

	receiver, _ := payload["receiver"].(map[string]any)
	receiverName, nameInvalid, nameTruncated := boundedText(receiver["name"], 120, receiverID)
	publicRaw, exists := receiver["publicName"]
	if !exists {
		publicRaw = receiver["public_name"]
	}
	publicName, publicInvalid, publicTruncated := boundedText(publicRaw, 120, receiverName)
	remoteAddr, remoteInvalid, remoteTruncated := boundedText(options.RemoteAddr, 64, "")
	userAgent, agentInvalid, agentTruncated := boundedText(options.UserAgent, 256, "")
	receiverLat, latValid := coordinate(receiver["lat"], -90, 90)
	receiverLon, lonValid := coordinate(receiver["lon"], -180, 180)
	invalidFields := normalized.InvalidFieldCount
	if receiver != nil {
		if value, exists := receiver["lat"]; exists && value != nil && !latValid {
			invalidFields++
		}
		if value, exists := receiver["lon"]; exists && value != nil && !lonValid {
			invalidFields++
		}
	}
	for _, invalid := range []bool{nameInvalid, publicInvalid, remoteInvalid, agentInvalid} {
		if invalid {
			invalidFields++
		}
	}
	truncatedFields := normalized.TruncatedFieldCount
	for _, truncated := range []bool{nameTruncated, publicTruncated, remoteTruncated, agentTruncated} {
		if truncated {
			truncatedFields++
		}
	}

	transaction, release, err := database.WriteTx(ctx, db)
	if err != nil {
		return Result{}, err
	}
	defer release()
	defer transaction.Rollback()

	if _, err := transaction.ExecContext(ctx, `
		INSERT INTO receivers (
		  id, name, public_name, lat, lon, last_seen_at, last_ip,
		  user_agent, total_ingests, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
		ON CONFLICT(id) DO UPDATE SET
		  name = COALESCE(excluded.name, receivers.name),
		  public_name = COALESCE(excluded.public_name, receivers.public_name),
		  lat = COALESCE(excluded.lat, receivers.lat),
		  lon = COALESCE(excluded.lon, receivers.lon),
		  last_seen_at = excluded.last_seen_at,
		  last_ip = excluded.last_ip,
		  user_agent = excluded.user_agent,
		  total_ingests = receivers.total_ingests + 1,
		  updated_at = excluded.updated_at
	`, receiverID, receiverName, publicName, receiverLat, receiverLon, receivedAt,
		nullableText(remoteAddr), nullableText(userAgent), receivedAt); err != nil {
		return Result{}, err
	}

	batch, err := transaction.ExecContext(ctx, `
		INSERT INTO ingest_batches (
		  receiver_id, received_at, source_now, aircraft_count, accepted_count,
		  track_points, remote_addr
		) VALUES (?, ?, ?, ?, 0, 0, ?)
	`, receiverID, receivedAt, normalized.SourceNow, len(rawAircraft), nullableText(remoteAddr))
	if err != nil {
		return Result{}, err
	}
	batchID, err := batch.LastInsertId()
	if err != nil {
		return Result{}, err
	}

	var currentCount int
	if err := transaction.QueryRowContext(
		ctx,
		"SELECT count(*) FROM receiver_aircraft_current WHERE receiver_id = ?",
		receiverID,
	).Scan(&currentCount); err != nil {
		return Result{}, err
	}
	result := Result{
		ReceiverID:              receiverID,
		BatchID:                 batchID,
		ReceivedAt:              receivedAt,
		SourceNow:               normalized.SourceNow,
		AircraftCount:           len(rawAircraft),
		TruncatedCount:          max(0, len(rawAircraft)-maxIngestAircraft),
		InvalidObservationCount: normalized.InvalidObservationCount,
		InvalidFieldCount:       invalidFields,
		TruncatedFieldCount:     truncatedFields,
		ChangedHexes:            []string{},
	}
	changed := make(map[string]struct{})
	for _, observation := range normalized.Aircraft {
		var exists int
		err := transaction.QueryRowContext(
			ctx,
			"SELECT 1 FROM receiver_aircraft_current WHERE receiver_id = ? AND hex = ?",
			receiverID,
			observation.Hex,
		).Scan(&exists)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return Result{}, err
		}
		present := err == nil
		if !present && currentCount >= maxReceiverCurrentAircraft {
			result.CurrentCapacityDroppedCount++
			continue
		}

		var latest *trackPosition
		if observation.Lat != nil && observation.Lon != nil && observation.PositionAt != nil {
			var value trackPosition
			err := transaction.QueryRowContext(ctx, `
				SELECT position_at, lat, lon FROM track_points
				WHERE hex = ? AND receiver_id = ?
				ORDER BY id DESC
				LIMIT 1
			`, observation.Hex, receiverID).Scan(&value.PositionAt, &value.Lat, &value.Lon)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return Result{}, err
			}
			if err == nil {
				latest = &value
			}
		}
		if latest != nil && !plausiblePosition(*latest, observation, options.PositionFilterMaxMach) {
			observation.PositionAt = nil
			observation.Lat = nil
			observation.Lon = nil
			result.FilteredPositionCount++
		}

		if err := upsertCurrent(ctx, transaction, receiverID, observation); err != nil {
			return Result{}, err
		}
		if !present {
			currentCount++
		}
		result.AcceptedCount++
		if _, exists := changed[observation.Hex]; !exists {
			changed[observation.Hex] = struct{}{}
			result.ChangedHexes = append(result.ChangedHexes, observation.Hex)
		}

		if observation.Lat != nil && observation.Lon != nil && observation.PositionAt != nil {
			shouldTrack := latest == nil || secondsBetween(latest.PositionAt, *observation.PositionAt) >= options.TrackMinIntervalSeconds
			if shouldTrack {
				allowed := options.ConsumeTrackBudget == nil || options.ConsumeTrackBudget(receiverID)
				if !allowed {
					result.TrackBudgetDroppedCount++
				} else {
					changes, err := insertTrack(ctx, transaction, receiverID, observation)
					if err != nil {
						return Result{}, err
					}
					result.TrackPoints += changes
				}
			}
		}
	}
	if _, err := transaction.ExecContext(
		ctx,
		"UPDATE ingest_batches SET accepted_count = ?, track_points = ? WHERE id = ?",
		result.AcceptedCount,
		result.TrackPoints,
		batchID,
	); err != nil {
		return Result{}, err
	}
	if options.TokenHash != "" {
		if _, err := transaction.ExecContext(
			ctx,
			"UPDATE receiver_tokens SET last_used_at = ? WHERE token_hash = ?",
			receivedAt,
			options.TokenHash,
		); err != nil {
			return Result{}, err
		}
	}
	if err := transaction.Commit(); err != nil {
		return Result{}, err
	}
	return result, nil
}

func selectedAircraftPayload(payload map[string]any) (map[string]any, []any) {
	if aircraft, ok := payload["aircraft"].([]any); ok {
		clone := cloneMap(payload)
		return clone, aircraft
	}
	if nested, ok := payload["payload"].(map[string]any); ok {
		if aircraft, ok := nested["aircraft"].([]any); ok {
			clone := cloneMap(nested)
			return clone, aircraft
		}
	}
	clone := cloneMap(payload)
	return clone, nil
}

func cloneMap(source map[string]any) map[string]any {
	clone := make(map[string]any, len(source)+1)
	for key, value := range source {
		clone[key] = value
	}
	return clone
}

func boundedText(value any, limit int, fallback string) (string, bool, bool) {
	if value == nil {
		return fallback, false, false
	}
	text, ok := scalarString(value)
	if !ok {
		return fallback, true, false
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return fallback, false, false
	}
	runes := []rune(text)
	truncated := len(runes) > limit
	if truncated {
		text = string(runes[:limit])
	}
	return text, false, truncated
}

func coordinate(value any, minValue, maxValue float64) (*float64, bool) {
	if value == nil || value == "" {
		return nil, true
	}
	number, ok := jsNumber(value)
	if !ok || !isFinite(number) || number < minValue || number > maxValue {
		return nil, false
	}
	return &number, true
}

type trackPosition struct {
	PositionAt string
	Lat        float64
	Lon        float64
}

func plausiblePosition(previous trackPosition, current Observation, maxMach float64) bool {
	if current.Lat == nil || current.Lon == nil || current.PositionAt == nil {
		return true
	}
	hours := secondsBetween(previous.PositionAt, *current.PositionAt) / 3600
	if !isFinite(hours) || hours <= 0 {
		return false
	}
	distance := distanceNauticalMiles(previous.Lat, previous.Lon, *current.Lat, *current.Lon)
	return distance/hours <= maxMach*666.739
}

func secondsBetween(first, second string) float64 {
	a, err := time.Parse(time.RFC3339Nano, first)
	if err != nil {
		return math.Inf(1)
	}
	b, err := time.Parse(time.RFC3339Nano, second)
	if err != nil {
		return math.Inf(1)
	}
	return b.Sub(a).Seconds()
}

func distanceNauticalMiles(aLat, aLon, bLat, bLon float64) float64 {
	const radiusNM = 3440.065
	toRadians := func(value float64) float64 { return value * math.Pi / 180 }
	dLat := toRadians(bLat - aLat)
	dLon := toRadians(bLon - aLon)
	lat1 := toRadians(aLat)
	lat2 := toRadians(bLat)
	h := math.Pow(math.Sin(dLat/2), 2) +
		math.Cos(lat1)*math.Cos(lat2)*math.Pow(math.Sin(dLon/2), 2)
	return 2 * radiusNM * math.Asin(math.Min(1, math.Sqrt(h)))
}

func upsertCurrent(ctx context.Context, transaction *sql.Tx, receiverID string, value Observation) error {
	_, err := transaction.ExecContext(ctx, `
		INSERT INTO receiver_aircraft_current (
		  receiver_id, hex, observed_at, position_at, lat, lon, flight, alt_baro,
		  alt_geom, on_ground, gs, ias, tas, mach, track, true_heading, mag_heading,
		  baro_rate, geom_rate, track_rate, roll, squawk, category, source_type,
		  source_kind, emergency, nav_qnh, nav_altitude_mcp, nav_altitude_fms,
		  nav_heading, wd, ws, oat, tat, nac_p, nac_v, nic, nic_baro, rc, sil,
		  sil_type, version, alert, spi, non_icao, messages, rssi, seen_seconds,
		  seen_pos_seconds
		) VALUES (
		  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
		  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		)
		ON CONFLICT(receiver_id, hex) DO UPDATE SET
		  observed_at=excluded.observed_at, position_at=excluded.position_at,
		  lat=excluded.lat, lon=excluded.lon, flight=excluded.flight,
		  alt_baro=excluded.alt_baro, alt_geom=excluded.alt_geom, on_ground=excluded.on_ground,
		  gs=excluded.gs, ias=excluded.ias, tas=excluded.tas, mach=excluded.mach,
		  track=excluded.track, true_heading=excluded.true_heading, mag_heading=excluded.mag_heading,
		  baro_rate=excluded.baro_rate, geom_rate=excluded.geom_rate,
		  track_rate=excluded.track_rate, roll=excluded.roll, squawk=excluded.squawk,
		  category=excluded.category, source_type=excluded.source_type,
		  source_kind=excluded.source_kind, emergency=excluded.emergency,
		  nav_qnh=excluded.nav_qnh, nav_altitude_mcp=excluded.nav_altitude_mcp,
		  nav_altitude_fms=excluded.nav_altitude_fms, nav_heading=excluded.nav_heading,
		  wd=excluded.wd, ws=excluded.ws, oat=excluded.oat, tat=excluded.tat,
		  nac_p=excluded.nac_p, nac_v=excluded.nac_v, nic=excluded.nic,
		  nic_baro=excluded.nic_baro, rc=excluded.rc, sil=excluded.sil,
		  sil_type=excluded.sil_type, version=excluded.version, alert=excluded.alert,
		  spi=excluded.spi, non_icao=excluded.non_icao, messages=excluded.messages,
		  rssi=excluded.rssi, seen_seconds=excluded.seen_seconds,
		  seen_pos_seconds=excluded.seen_pos_seconds
		WHERE excluded.observed_at >= receiver_aircraft_current.observed_at
	`,
		receiverID, value.Hex, value.ObservedAt, value.PositionAt, value.Lat, value.Lon,
		value.Flight, value.AltBaro, value.AltGeom, boolInteger(value.OnGround), value.GS,
		value.IAS, value.TAS, value.Mach, value.Track, value.TrueHeading, value.MagHeading,
		value.BaroRate, value.GeomRate, value.TrackRate, value.Roll, value.Squawk,
		value.Category, value.SourceType, value.SourceKind, value.Emergency, value.NavQNH,
		value.NavAltitudeMCP, value.NavAltitudeFMS, value.NavHeading, value.WindDirection,
		value.WindSpeed, value.OAT, value.TAT, value.NACP, value.NACV, value.NIC,
		value.NICBaro, value.RC, value.SIL, value.SILType, value.Version, value.Alert,
		value.SPI, boolInteger(value.NonICAO), value.Messages, value.RSSI, value.SeenSeconds,
		value.SeenPosSeconds,
	)
	return err
}

func insertTrack(ctx context.Context, transaction *sql.Tx, receiverID string, value Observation) (int, error) {
	result, err := transaction.ExecContext(ctx, `
		INSERT OR IGNORE INTO track_points (
		  hex, receiver_id, observed_at, position_at, lat, lon, alt_baro, alt_geom,
		  on_ground, gs, ias, tas, mach, track, true_heading, mag_heading,
		  baro_rate, geom_rate, wd, ws, oat, tat, source_type, messages, rssi
		) VALUES (
		  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		)
	`, value.Hex, receiverID, value.ObservedAt, value.PositionAt, value.Lat, value.Lon,
		value.AltBaro, value.AltGeom, boolInteger(value.OnGround), value.GS, value.IAS,
		value.TAS, value.Mach, value.Track, value.TrueHeading, value.MagHeading,
		value.BaroRate, value.GeomRate, value.WindDirection, value.WindSpeed, value.OAT,
		value.TAT, value.SourceType, value.Messages, value.RSSI)
	if err != nil {
		return 0, err
	}
	changes, err := result.RowsAffected()
	return int(changes), err
}

func boolInteger(value bool) int {
	if value {
		return 1
	}
	return 0
}

func nullableText(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func SortedChangedHexes(values []string) []string {
	copyOfValues := append([]string(nil), values...)
	sort.Strings(copyOfValues)
	return copyOfValues
}
