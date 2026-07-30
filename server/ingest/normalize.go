package ingest

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	aircraftIDPattern  = regexp.MustCompile(`^~?[0-9a-f]{6}$`)
	numericDatePattern = regexp.MustCompile(`^\d+(?:\.\d+)?$`)
)

type NormalizationStats struct {
	InvalidFieldCount       int
	TruncatedFieldCount     int
	InvalidObservationCount int
}

type Observation struct {
	Hex            string   `json:"hex"`
	NonICAO        bool     `json:"nonIcao"`
	SourceType     *string  `json:"sourceType"`
	SourceKind     string   `json:"sourceKind"`
	Flight         *string  `json:"flight"`
	ObservedAt     string   `json:"observedAt"`
	PositionAt     *string  `json:"positionAt"`
	Lat            *float64 `json:"lat"`
	Lon            *float64 `json:"lon"`
	AltBaro        *float64 `json:"altBaro"`
	AltGeom        *float64 `json:"altGeom"`
	OnGround       bool     `json:"onGround"`
	GS             *float64 `json:"gs"`
	IAS            *float64 `json:"ias"`
	TAS            *float64 `json:"tas"`
	Mach           *float64 `json:"mach"`
	Track          *float64 `json:"track"`
	TrueHeading    *float64 `json:"trueHeading"`
	MagHeading     *float64 `json:"magHeading"`
	BaroRate       *float64 `json:"baroRate"`
	GeomRate       *float64 `json:"geomRate"`
	TrackRate      *float64 `json:"trackRate"`
	Roll           *float64 `json:"roll"`
	Squawk         *string  `json:"squawk"`
	Category       *string  `json:"category"`
	Emergency      *string  `json:"emergency"`
	NavQNH         *float64 `json:"navQnh"`
	NavAltitudeMCP *float64 `json:"navAltitudeMcp"`
	NavAltitudeFMS *float64 `json:"navAltitudeFms"`
	NavHeading     *float64 `json:"navHeading"`
	WindDirection  *float64 `json:"windDirection"`
	WindSpeed      *float64 `json:"windSpeed"`
	OAT            *float64 `json:"oat"`
	TAT            *float64 `json:"tat"`
	NACP           *int64   `json:"nacP"`
	NACV           *int64   `json:"nacV"`
	NIC            *int64   `json:"nic"`
	NICBaro        *int64   `json:"nicBaro"`
	RC             *int64   `json:"rc"`
	SIL            *int64   `json:"sil"`
	SILType        *string  `json:"silType"`
	Version        *int64   `json:"version"`
	Alert          *int64   `json:"alert"`
	SPI            *int64   `json:"spi"`
	Messages       *int64   `json:"messages"`
	RSSI           *float64 `json:"rssi"`
	SeenSeconds    float64  `json:"seenSeconds"`
	SeenPosSeconds *float64 `json:"seenPosSeconds"`
}

type NormalizedPayload struct {
	SourceNow *string
	Aircraft  []Observation
	NormalizationStats
}

func NormalizePayload(payload map[string]any, receivedAt time.Time, maxObservationAgeSeconds float64) NormalizedPayload {
	stats := NormalizationStats{}
	rawAircraft, _ := payload["aircraft"].([]any)
	aircraft := make([]Observation, 0, len(rawAircraft))
	for _, raw := range rawAircraft {
		observation, ok := normalizeAircraft(raw, receivedAt, maxObservationAgeSeconds, &stats)
		if ok {
			aircraft = append(aircraft, observation)
		}
	}
	return NormalizedPayload{
		SourceNow:          diagnosticSourceNow(payload["now"]),
		Aircraft:           aircraft,
		NormalizationStats: stats,
	}
}

func NormalizeAircraft(raw any, receivedAt time.Time, maxObservationAgeSeconds float64) (Observation, NormalizationStats, bool) {
	stats := NormalizationStats{}
	value, ok := normalizeAircraft(raw, receivedAt, maxObservationAgeSeconds, &stats)
	return value, stats, ok
}

func normalizeAircraft(rawValue any, receivedAt time.Time, maxAge float64, stats *NormalizationStats) (Observation, bool) {
	raw, ok := rawValue.(map[string]any)
	if !ok {
		stats.InvalidObservationCount++
		return Observation{}, false
	}
	hexValue, ok := raw["hex"].(string)
	if !ok {
		stats.InvalidObservationCount++
		return Observation{}, false
	}
	hexValue = strings.ToLower(strings.TrimSpace(hexValue))
	if !aircraftIDPattern.MatchString(hexValue) {
		stats.InvalidObservationCount++
		return Observation{}, false
	}
	if !isFinite(maxAge) {
		maxAge = 120
	}
	seen := finiteInRange(raw["seen"], 0, maxAge, stats)
	if seen == nil {
		stats.InvalidObservationCount++
		return Observation{}, false
	}

	seenPos := finiteInRange(raw["seen_pos"], 0, maxAge, stats)
	lat := finiteInRange(raw["lat"], -90, 90, stats)
	lon := finiteInRange(raw["lon"], -180, 180, stats)
	hasPosition := seenPos != nil && lat != nil && lon != nil
	if !hasPosition {
		lat = nil
		lon = nil
		seenPos = nil
	}
	altBaro, onGround := altitude(raw["alt_baro"], stats)
	sourceType := boundedString(raw["type"], 32, stats)
	source := sourceKind(raw, sourceType)
	nonICAO := strings.HasPrefix(hexValue, "~")
	if sourceType != nil && !strings.Contains(strings.ToLower(*sourceType), "icao") {
		nonICAO = true
	}
	observedAt := iso(receivedAt.Add(-time.Duration(*seen * float64(time.Second))))
	var positionAt *string
	if hasPosition {
		value := iso(receivedAt.Add(-time.Duration(*seenPos * float64(time.Second))))
		positionAt = &value
	}

	return Observation{
		Hex:            hexValue,
		NonICAO:        nonICAO,
		SourceType:     sourceType,
		SourceKind:     source,
		Flight:         boundedString(raw["flight"], 16, stats),
		ObservedAt:     observedAt,
		PositionAt:     positionAt,
		Lat:            lat,
		Lon:            lon,
		AltBaro:        altBaro,
		AltGeom:        finiteInRange(raw["alt_geom"], -2000, 100000, stats),
		OnGround:       onGround,
		GS:             finiteInRange(raw["gs"], 0, 3000, stats),
		IAS:            finiteInRange(raw["ias"], 0, 3000, stats),
		TAS:            finiteInRange(raw["tas"], 0, 3000, stats),
		Mach:           finiteInRange(raw["mach"], 0, 10, stats),
		Track:          heading(raw["track"], stats),
		TrueHeading:    heading(raw["true_heading"], stats),
		MagHeading:     heading(raw["mag_heading"], stats),
		BaroRate:       finiteInRange(raw["baro_rate"], -50000, 50000, stats),
		GeomRate:       finiteInRange(raw["geom_rate"], -50000, 50000, stats),
		TrackRate:      finiteInRange(raw["track_rate"], -50000, 50000, stats),
		Roll:           finiteInRange(raw["roll"], -180, 180, stats),
		Squawk:         boundedString(raw["squawk"], 8, stats),
		Category:       boundedString(raw["category"], 8, stats),
		Emergency:      boundedString(raw["emergency"], 32, stats),
		NavQNH:         finiteInRange(raw["nav_qnh"], 800, 1200, stats),
		NavAltitudeMCP: finiteInRange(raw["nav_altitude_mcp"], -2000, 100000, stats),
		NavAltitudeFMS: finiteInRange(raw["nav_altitude_fms"], -2000, 100000, stats),
		NavHeading:     heading(raw["nav_heading"], stats),
		WindDirection:  heading(raw["wd"], stats),
		WindSpeed:      finiteInRange(raw["ws"], 0, 500, stats),
		OAT:            finiteInRange(raw["oat"], -200, 200, stats),
		TAT:            finiteInRange(raw["tat"], -200, 200, stats),
		NACP:           safeInteger(raw["nac_p"], stats),
		NACV:           safeInteger(raw["nac_v"], stats),
		NIC:            safeInteger(raw["nic"], stats),
		NICBaro:        safeInteger(raw["nic_baro"], stats),
		RC:             safeInteger(raw["rc"], stats),
		SIL:            safeInteger(raw["sil"], stats),
		SILType:        boundedString(raw["sil_type"], 16, stats),
		Version:        safeInteger(raw["version"], stats),
		Alert:          safeInteger(raw["alert"], stats),
		SPI:            safeInteger(raw["spi"], stats),
		Messages:       safeInteger(raw["messages"], stats),
		RSSI:           finiteInRange(raw["rssi"], -500, 100, stats),
		SeenSeconds:    *seen,
		SeenPosSeconds: seenPos,
	}, true
}

func finiteInRange(value any, minValue, maxValue float64, stats *NormalizationStats) *float64 {
	if value == nil || value == "" {
		return nil
	}
	number, ok := jsNumber(value)
	if !ok || !isFinite(number) || number < minValue || number > maxValue {
		stats.InvalidFieldCount++
		return nil
	}
	return &number
}

func safeInteger(value any, stats *NormalizationStats) *int64 {
	if value == nil || value == "" {
		return nil
	}
	number, ok := jsNumber(value)
	if !ok || !isFinite(number) || math.Trunc(number) != number || math.Abs(number) > 1<<53-1 {
		stats.InvalidFieldCount++
		return nil
	}
	integer := int64(number)
	return &integer
}

func boundedString(value any, limit int, stats *NormalizationStats) *string {
	if value == nil {
		return nil
	}
	text, ok := scalarString(value)
	if !ok {
		stats.InvalidFieldCount++
		return nil
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	runes := []rune(text)
	if len(runes) > limit {
		stats.TruncatedFieldCount++
		text = string(runes[:limit])
	}
	return &text
}

func heading(value any, stats *NormalizationStats) *float64 {
	if value == nil || value == "" {
		return nil
	}
	number, ok := jsNumber(value)
	if !ok || !isFinite(number) {
		stats.InvalidFieldCount++
		return nil
	}
	number = math.Mod(math.Mod(number, 360)+360, 360)
	return &number
}

func altitude(value any, stats *NormalizationStats) (*float64, bool) {
	if text, ok := value.(string); ok && text == "ground" {
		zero := float64(0)
		return &zero, true
	}
	return finiteInRange(value, -2000, 100000, stats), false
}

func sourceKind(raw map[string]any, sourceType *string) string {
	if sourceType != nil {
		kind := strings.ToLower(*sourceType)
		switch {
		case strings.Contains(kind, "mlat"):
			return "mlat"
		case strings.Contains(kind, "tisb"):
			return "tisb"
		case strings.Contains(kind, "uat"):
			return "uat"
		case strings.Contains(kind, "adsb"):
			return "adsb"
		}
		if kind != "" {
			return kind
		}
	}
	if values, ok := raw["mlat"].([]any); ok && len(values) != 0 {
		return "mlat"
	}
	if values, ok := raw["tisb"].([]any); ok && len(values) != 0 {
		return "tisb"
	}
	return "unknown"
}

func diagnosticSourceNow(value any) *string {
	if value == nil || value == "" {
		return nil
	}
	var parsed time.Time
	switch typed := value.(type) {
	case json.Number:
		number, err := typed.Float64()
		if err != nil {
			return nil
		}
		parsed = unixSourceTime(number)
	case float64:
		parsed = unixSourceTime(typed)
	case string:
		text := strings.TrimSpace(typed)
		if numericDatePattern.MatchString(text) {
			number, err := strconv.ParseFloat(text, 64)
			if err != nil {
				return nil
			}
			parsed = unixSourceTime(number)
		} else {
			var err error
			parsed, err = time.Parse(time.RFC3339Nano, typed)
			if err != nil {
				return nil
			}
		}
	default:
		return nil
	}
	if parsed.IsZero() {
		return nil
	}
	result := iso(parsed)
	return &result
}

func unixSourceTime(value float64) time.Time {
	if !isFinite(value) {
		return time.Time{}
	}
	if value > 1e11 {
		return time.Unix(0, int64(value*float64(time.Millisecond))).UTC()
	}
	return time.Unix(0, int64(value*float64(time.Second))).UTC()
}

func jsNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case json.Number:
		number, err := typed.Float64()
		return number, err == nil
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return 0, true
		}
		number, err := strconv.ParseFloat(text, 64)
		return number, err == nil
	case bool:
		if typed {
			return 1, true
		}
		return 0, true
	default:
		return 0, false
	}
}

func scalarString(value any) (string, bool) {
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

func SanitizeReceiverID(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if len(value) < 1 || len(value) > 64 {
		return "", false
	}
	for index, character := range value {
		if character >= 'A' && character <= 'Z' ||
			character >= 'a' && character <= 'z' ||
			character >= '0' && character <= '9' ||
			index > 0 && strings.ContainsRune("_.:-", character) {
			continue
		}
		return "", false
	}
	return value, true
}

func IsFresh(observedAt, receivedAt string, maxAgeSeconds float64) bool {
	observed, err := time.Parse(time.RFC3339Nano, observedAt)
	if err != nil {
		return false
	}
	received, err := time.Parse(time.RFC3339Nano, receivedAt)
	if err != nil {
		return false
	}
	age := received.Sub(observed)
	return age >= 0 && age <= time.Duration(maxAgeSeconds*float64(time.Second))
}

func IsValidAircraftID(value string) bool {
	return aircraftIDPattern.MatchString(strings.ToLower(strings.TrimSpace(value)))
}

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func iso(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}
