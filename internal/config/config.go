package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const maxSafeInteger = 1<<53 - 1

type ReceiverToken struct {
	ReceiverID string
	Token      string
}

type Config struct {
	Port                                 int
	DBPath                               string
	AirfieldsDir                         string
	AirfieldsAirportsURL                 string
	AirfieldsRunwaysURL                  string
	AirfieldsRefreshSeconds              int
	AreaFeedURL                          string
	AreaFeedTTLSeconds                   int
	AreaFeedMinUpstreamMS                int
	StaticDir                            string
	TrustProxy                           []netip.Prefix
	ReceiverTokens                       []ReceiverToken
	CurrentWindowSeconds                 int
	LiveMaxAircraft                      int
	LiveMaxBytes                         int
	MaxObservationAgeSeconds             int
	TrackMinIntervalSeconds              int
	PositionFilterMaxMach                float64
	TrackRetentionDays                   int
	BatchRetentionDays                   int
	CurrentRetentionHours                int
	CoverageWindowHours                  int
	CoverageRefreshSeconds               int
	CoverageHorizontalStepNM             float64
	CoverageVerticalStepFT               float64
	CoverageCellHorizontalStepNM         float64
	CoverageCellVerticalStepFT           float64
	CoverageAggregationChunkSize         int
	CoverageHorizontalSupportNM          float64
	CoverageVerticalSupportFT            float64
	CoverageHorizontalInterpolationCells int
	CoverageHorizontalSmoothingPasses    int
	CoverageVerticalSmoothingPasses      int
	CoverageSmoothingIterations          int
	CoverageMaxCells                     int
	CoverageMaxTriangles                 int
}

func Environment() map[string]string {
	env := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			env[key] = value
		}
	}
	return env
}

func Load(env map[string]string) (Config, error) {
	for _, key := range []string{
		"SKYTRACE_INGEST_TOKEN",
		"SKYTRACE_INGEST_TOKENS",
		"SKYTRACE_MAX_TRACK_QUERY_POINTS",
		"SKYTRACE_REQUIRE_HTTPS",
	} {
		if env[key] != "" {
			return Config{}, invalid(key, "this setting was removed")
		}
	}

	horizontalStep, err := numberValue(env, "SKYTRACE_COVERAGE_HORIZONTAL_STEP_NM", 2, math.SmallestNonzeroFloat64, math.MaxFloat64)
	if err != nil {
		return Config{}, err
	}
	verticalStep, err := numberValue(env, "SKYTRACE_COVERAGE_VERTICAL_STEP_FT", 800, math.SmallestNonzeroFloat64, math.MaxFloat64)
	if err != nil {
		return Config{}, err
	}
	coverageWindow, err := intValue(env, "SKYTRACE_COVERAGE_WINDOW_HOURS", 24*30, 1, 24*365)
	if err != nil {
		return Config{}, err
	}
	trackRetention, err := intValue(env, "SKYTRACE_TRACK_RETENTION_DAYS", 90, 1, 365)
	if err != nil {
		return Config{}, err
	}
	minimumRetention := (coverageWindow+23)/24 + 1
	if trackRetention < minimumRetention {
		return Config{}, invalid(
			"SKYTRACE_TRACK_RETENTION_DAYS",
			fmt.Sprintf("must be at least %d for the configured coverage window", minimumRetention),
		)
	}

	dbPath, err := absoluteDefault(env["SKYTRACE_DB_PATH"], filepath.Join("data", "skytrace.db"))
	if err != nil {
		return Config{}, err
	}
	staticDir, err := absoluteDefault(env["SKYTRACE_STATIC_DIR"], filepath.Join("web", "dist"))
	if err != nil {
		return Config{}, err
	}
	airfieldsDir := env["SKYTRACE_AIRFIELDS_DIR"]
	if airfieldsDir == "" {
		airfieldsDir = filepath.Join(filepath.Dir(dbPath), "airfields")
	}
	if !filepath.IsAbs(airfieldsDir) {
		airfieldsDir, err = filepath.Abs(airfieldsDir)
		if err != nil {
			return Config{}, fmt.Errorf("resolve SKYTRACE_AIRFIELDS_DIR: %w", err)
		}
	}

	port, err := intValue(env, "PORT", 3000, 0, 65535)
	if err != nil {
		return Config{}, err
	}
	airfieldsRefresh, err := intValue(env, "SKYTRACE_AIRFIELDS_REFRESH_SECONDS", 7*24*3600, 0, maxSafeInteger)
	if err != nil {
		return Config{}, err
	}
	areaTTL, err := intValue(env, "SKYTRACE_AREA_FEED_TTL_SECONDS", 5, 0, maxSafeInteger)
	if err != nil {
		return Config{}, err
	}
	areaGap, err := intValue(env, "SKYTRACE_AREA_FEED_MIN_UPSTREAM_MS", 1100, 0, maxSafeInteger)
	if err != nil {
		return Config{}, err
	}
	trustProxy, err := parseTrustProxy(env["SKYTRACE_TRUST_PROXY"])
	if err != nil {
		return Config{}, err
	}
	tokens, err := parseReceiverTokens(env["SKYTRACE_RECEIVER_TOKENS"])
	if err != nil {
		return Config{}, err
	}
	currentWindow, err := intValue(env, "SKYTRACE_CURRENT_WINDOW_SECONDS", 90, 0, maxSafeInteger)
	if err != nil {
		return Config{}, err
	}
	liveMaxAircraft, err := intValue(env, "SKYTRACE_LIVE_MAX_AIRCRAFT", 5000, 100, 20000)
	if err != nil {
		return Config{}, err
	}
	liveMaxBytes, err := intValue(env, "SKYTRACE_LIVE_MAX_BYTES", 8*1024*1024, 64*1024, 32*1024*1024)
	if err != nil {
		return Config{}, err
	}
	observationAge, err := intValue(env, "SKYTRACE_MAX_OBSERVATION_AGE_SECONDS", 120, 0, maxSafeInteger)
	if err != nil {
		return Config{}, err
	}
	trackInterval, err := intValue(env, "SKYTRACE_TRACK_MIN_INTERVAL_SECONDS", 3, 0, maxSafeInteger)
	if err != nil {
		return Config{}, err
	}
	maxMach, err := numberValue(env, "SKYTRACE_POSITION_FILTER_MAX_MACH", 3.5, math.SmallestNonzeroFloat64, math.MaxFloat64)
	if err != nil {
		return Config{}, err
	}
	batchRetention, err := intValue(env, "SKYTRACE_INGEST_BATCH_RETENTION_DAYS", 7, 1, 90)
	if err != nil {
		return Config{}, err
	}
	coverageRefresh, err := intValue(env, "SKYTRACE_COVERAGE_REFRESH_SECONDS", 180, 0, maxSafeInteger)
	if err != nil {
		return Config{}, err
	}
	cellHorizontalStep, err := numberValue(
		env,
		"SKYTRACE_COVERAGE_CELL_HORIZONTAL_STEP_NM",
		horizontalStep/2,
		math.SmallestNonzeroFloat64,
		math.MaxFloat64,
	)
	if err != nil {
		return Config{}, err
	}
	cellVerticalStep, err := numberValue(
		env,
		"SKYTRACE_COVERAGE_CELL_VERTICAL_STEP_FT",
		verticalStep/2,
		math.SmallestNonzeroFloat64,
		math.MaxFloat64,
	)
	if err != nil {
		return Config{}, err
	}
	aggregationChunk, err := intValue(env, "SKYTRACE_COVERAGE_AGGREGATION_CHUNK_SIZE", 5000, 0, maxSafeInteger)
	if err != nil {
		return Config{}, err
	}
	horizontalSupport, err := numberValue(env, "SKYTRACE_COVERAGE_HORIZONTAL_SUPPORT_NM", 4.5, math.SmallestNonzeroFloat64, math.MaxFloat64)
	if err != nil {
		return Config{}, err
	}
	verticalSupport, err := numberValue(env, "SKYTRACE_COVERAGE_VERTICAL_SUPPORT_FT", 2500, math.SmallestNonzeroFloat64, math.MaxFloat64)
	if err != nil {
		return Config{}, err
	}
	horizontalInterpolation, err := intValue(env, "SKYTRACE_COVERAGE_HORIZONTAL_INTERPOLATION_CELLS", 2, 0, maxSafeInteger)
	if err != nil {
		return Config{}, err
	}
	horizontalSmoothing, err := intValue(env, "SKYTRACE_COVERAGE_HORIZONTAL_SMOOTHING_PASSES", 2, 0, maxSafeInteger)
	if err != nil {
		return Config{}, err
	}
	verticalSmoothing, err := intValue(env, "SKYTRACE_COVERAGE_VERTICAL_SMOOTHING_PASSES", 4, 0, maxSafeInteger)
	if err != nil {
		return Config{}, err
	}
	smoothingIterations, err := intValue(env, "SKYTRACE_COVERAGE_SMOOTHING_ITERATIONS", 5, 0, maxSafeInteger)
	if err != nil {
		return Config{}, err
	}
	maxCells, err := intValue(env, "SKYTRACE_COVERAGE_MAX_CELLS", 1200000, 0, maxSafeInteger)
	if err != nil {
		return Config{}, err
	}
	maxTriangles, err := intValue(env, "SKYTRACE_COVERAGE_MAX_TRIANGLES", 200000, 0, maxSafeInteger)
	if err != nil {
		return Config{}, err
	}

	return Config{
		Port:                                 port,
		DBPath:                               dbPath,
		AirfieldsDir:                         filepath.Clean(airfieldsDir),
		AirfieldsAirportsURL:                 env["SKYTRACE_AIRFIELDS_AIRPORTS_URL"],
		AirfieldsRunwaysURL:                  env["SKYTRACE_AIRFIELDS_RUNWAYS_URL"],
		AirfieldsRefreshSeconds:              airfieldsRefresh,
		AreaFeedURL:                          env["SKYTRACE_AREA_FEED_URL"],
		AreaFeedTTLSeconds:                   areaTTL,
		AreaFeedMinUpstreamMS:                areaGap,
		StaticDir:                            staticDir,
		TrustProxy:                           trustProxy,
		ReceiverTokens:                       tokens,
		CurrentWindowSeconds:                 currentWindow,
		LiveMaxAircraft:                      liveMaxAircraft,
		LiveMaxBytes:                         liveMaxBytes,
		MaxObservationAgeSeconds:             observationAge,
		TrackMinIntervalSeconds:              trackInterval,
		PositionFilterMaxMach:                maxMach,
		TrackRetentionDays:                   trackRetention,
		BatchRetentionDays:                   batchRetention,
		CurrentRetentionHours:                24,
		CoverageWindowHours:                  coverageWindow,
		CoverageRefreshSeconds:               coverageRefresh,
		CoverageHorizontalStepNM:             horizontalStep,
		CoverageVerticalStepFT:               verticalStep,
		CoverageCellHorizontalStepNM:         cellHorizontalStep,
		CoverageCellVerticalStepFT:           cellVerticalStep,
		CoverageAggregationChunkSize:         aggregationChunk,
		CoverageHorizontalSupportNM:          horizontalSupport,
		CoverageVerticalSupportFT:            verticalSupport,
		CoverageHorizontalInterpolationCells: horizontalInterpolation,
		CoverageHorizontalSmoothingPasses:    horizontalSmoothing,
		CoverageVerticalSmoothingPasses:      verticalSmoothing,
		CoverageSmoothingIterations:          smoothingIterations,
		CoverageMaxCells:                     maxCells,
		CoverageMaxTriangles:                 maxTriangles,
	}, nil
}

func invalid(key, detail string) error {
	return fmt.Errorf("invalid %s: %s", key, detail)
}

func absoluteDefault(value, fallback string) (string, error) {
	if value == "" {
		value = fallback
	}
	resolved, err := filepath.Abs(value)
	if err != nil {
		return "", err
	}
	return filepath.Clean(resolved), nil
}

func intValue(env map[string]string, key string, fallback, minValue, maxValue int) (int, error) {
	raw := env[key]
	if raw == "" {
		return fallback, nil
	}
	if strings.HasPrefix(raw, "+") || strings.Trim(raw, "-0123456789") != "" || raw == "-" {
		return 0, invalid(key, "expected an integer")
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < int64(minValue) || value > int64(maxValue) {
		return 0, invalid(key, fmt.Sprintf("expected an integer from %d to %d", minValue, maxValue))
	}
	return int(value), nil
}

func numberValue(env map[string]string, key string, fallback, minValue, maxValue float64) (float64, error) {
	raw := env[key]
	if raw == "" {
		return fallback, nil
	}
	text := strings.TrimSpace(raw)
	if text == "" {
		text = "0"
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < minValue || value > maxValue {
		return 0, invalid(key, fmt.Sprintf("expected a number from %s to %s", formatNumber(minValue), formatNumber(maxValue)))
	}
	return value, nil
}

func formatNumber(value float64) string {
	return strconv.FormatFloat(value, 'g', -1, 64)
}

func parseReceiverTokens(raw string) ([]ReceiverToken, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &object); err != nil || object == nil {
		return nil, invalid("SKYTRACE_RECEIVER_TOKENS", "expected a JSON object")
	}
	var generic any
	if err := json.Unmarshal([]byte(raw), &generic); err != nil {
		return nil, invalid("SKYTRACE_RECEIVER_TOKENS", "expected a JSON object")
	}
	if _, ok := generic.(map[string]any); !ok {
		return nil, invalid("SKYTRACE_RECEIVER_TOKENS", "expected a JSON object")
	}

	tokens := make([]ReceiverToken, 0, len(object))
	seen := make(map[string]struct{}, len(object))
	for receiverID, encoded := range object {
		if !validReceiverID(receiverID) {
			return nil, invalid("SKYTRACE_RECEIVER_TOKENS", fmt.Sprintf("invalid receiver id %q", receiverID))
		}
		var token string
		if err := json.Unmarshal(encoded, &token); err != nil || len(token) < 32 {
			return nil, invalid(
				"SKYTRACE_RECEIVER_TOKENS",
				fmt.Sprintf("token for %s must be a string of at least 32 characters", receiverID),
			)
		}
		if _, exists := seen[token]; exists {
			return nil, invalid("SKYTRACE_RECEIVER_TOKENS", "tokens must be unique")
		}
		seen[token] = struct{}{}
		tokens = append(tokens, ReceiverToken{ReceiverID: receiverID, Token: token})
	}
	sort.Slice(tokens, func(i, j int) bool {
		return tokens[i].ReceiverID < tokens[j].ReceiverID
	})
	return tokens, nil
}

func validReceiverID(value string) bool {
	if len(value) < 1 || len(value) > 64 {
		return false
	}
	for index, character := range value {
		if character >= 'A' && character <= 'Z' ||
			character >= 'a' && character <= 'z' ||
			character >= '0' && character <= '9' ||
			index > 0 && strings.ContainsRune("_.:-", character) {
			continue
		}
		return false
	}
	return true
}

func parseTrustProxy(raw string) ([]netip.Prefix, error) {
	if raw == "" {
		return nil, nil
	}
	text := strings.TrimSpace(raw)
	if text == "true" || text == "false" {
		return nil, invalid("SKYTRACE_TRUST_PROXY", "expected 0 or an explicit IP/CIDR list, not a boolean")
	}
	if _, err := strconv.ParseUint(text, 10, 64); err == nil {
		if text == "0" {
			return nil, nil
		}
		return nil, invalid("SKYTRACE_TRUST_PROXY", "positive hop counts are unsafe; use explicit proxy IP/CIDR entries")
	}
	entries := strings.Split(text, ",")
	prefixes := make([]netip.Prefix, 0, len(entries))
	for _, entry := range entries {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			return nil, invalid("SKYTRACE_TRUST_PROXY", "expected 0 or a comma-separated IP/CIDR list")
		}
		if address, err := netip.ParseAddr(entry); err == nil {
			prefixes = append(prefixes, netip.PrefixFrom(address, address.BitLen()))
			continue
		}
		prefix, err := netip.ParsePrefix(entry)
		if err != nil {
			return nil, invalid("SKYTRACE_TRUST_PROXY", "expected 0 or a comma-separated IP/CIDR list")
		}
		prefixes = append(prefixes, prefix)
	}
	return prefixes, nil
}

func (config Config) Validate() error {
	if config.DBPath == "" {
		return errors.New("database path is empty")
	}
	return nil
}
