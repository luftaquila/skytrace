package coverage

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/luftaquila/skytrace/server/database"
)

func testCoverageDB(t *testing.T) *database.DB {
	t.Helper()
	db, err := database.Open(context.Background(), filepath.Join(t.TempDir(), "skytrace.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	_, err = db.SQL.Exec(`
		INSERT INTO receivers (id, name, public_name, lat, lon, updated_at)
		VALUES ('rx-1', 'Receiver 1', 'Receiver 1', 37.5, 127.0, ?)
	`, "2026-07-23T00:00:00.000Z")
	if err != nil {
		t.Fatal(err)
	}
	return db
}

func testCoverageOptions() Options {
	return Options{
		WindowHours:                  24 * 30,
		HorizontalStepNM:             2,
		VerticalStepFT:               800,
		CellHorizontalStepNM:         1,
		CellVerticalStepFT:           400,
		HorizontalSupportNM:          4.5,
		VerticalSupportFT:            2500,
		HorizontalInterpolationCells: 2,
		HorizontalSmoothingPasses:    2,
		VerticalSmoothingPasses:      4,
		SmoothingIterations:          2,
		MaxCells:                     1200000,
		MaxTriangles:                 200000,
		AggregationChunkSize:         5000,
	}
}

func addTrackPoints(t *testing.T, db *database.DB, points []trackPoint) {
	t.Helper()
	transaction, err := db.SQL.Begin()
	if err != nil {
		t.Fatal(err)
	}
	for _, point := range points {
		_, err := transaction.Exec(`
			INSERT INTO track_points (
				hex, receiver_id, observed_at, position_at, lat, lon, alt_baro
			)
			VALUES (?, 'rx-1', ?, ?, ?, ?, ?)
		`, defaultString(point.hex, "abc123"), point.positionAt, point.positionAt,
			point.lat, point.lon, point.altitude)
		if err != nil {
			transaction.Rollback()
			t.Fatal(err)
		}
	}
	if err := transaction.Commit(); err != nil {
		t.Fatal(err)
	}
}

func defaultString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func TestCoverageConfigKeyMatchesNodeContract(t *testing.T) {
	options := NormalizeOptions(testCoverageOptions())
	const expected = "08ea7be3fdb4a7a61fc71f132fb54f2640976f05ff7265bdedf300fb7e2ad572"
	if options.ConfigKey != expected {
		t.Fatalf("config key = %s, want %s", options.ConfigKey, expected)
	}
}

func TestSnapDatumProtectsPrivateReceiverCoordinates(t *testing.T) {
	if got, want := SnapDatum(37.61, 127.11), SnapDatum(37.70, 127.20); got != want {
		t.Fatalf("same coarse cell did not match: %#v != %#v", got, want)
	}
	if got, want := SnapDatum(95, 180), (Origin{Lat: 90, Lon: -180}); got != want {
		t.Fatalf("antimeridian snap = %#v, want %#v", got, want)
	}
	if got, want := SnapDatum(-37.75, -127.25), (Origin{Lat: -37.5, Lon: -127}); got != want {
		t.Fatalf("negative half snap = %#v, want JavaScript Math.round parity %#v", got, want)
	}
}

func TestAggregationAdvancesCursorAndRebuildsForExpandedWindow(t *testing.T) {
	db := testCoverageDB(t)
	addTrackPoints(t, db, []trackPoint{
		{positionAt: "2026-07-01T00:00:00.000Z", lat: 37.35, lon: 126.85, altitude: 4000},
		{positionAt: "2026-07-22T23:59:00.000Z", lat: 37.50, lon: 127.00, altitude: 8000},
		{positionAt: "2026-07-22T23:59:03.000Z", lat: 37.518, lon: 127.018, altitude: 8800},
		{positionAt: "2026-07-22T23:59:06.000Z", lat: 37.536, lon: 127.036, altitude: 9600},
		{positionAt: "2026-07-22T23:59:09.000Z", lat: 37.554, lon: 127.054, altitude: 10400},
	})
	now := time.Date(2026, 7, 23, 0, 0, 0, 0, time.UTC)
	options := testCoverageOptions()
	options.WindowHours = 24 * 14
	first, err := SyncCells(context.Background(), db.SQL, options, now)
	if err != nil {
		t.Fatal(err)
	}
	if first.RawPoints != 4 {
		t.Fatalf("first raw points = %d, want 4", first.RawPoints)
	}
	var oldCellCount int
	if err := db.SQL.QueryRow("SELECT COUNT(*) FROM coverage_cells WHERE lat < 37.4").Scan(&oldCellCount); err != nil {
		t.Fatal(err)
	}
	if oldCellCount != 0 {
		t.Fatalf("expired cells remained: %d", oldCellCount)
	}

	addTrackPoints(t, db, []trackPoint{{
		positionAt: "2026-07-23T00:00:12.000Z", lat: 37.57, lon: 127.07, altitude: 11200,
	}})
	second, err := SyncCells(context.Background(), db.SQL, options, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if second.RawPoints != 1 {
		t.Fatalf("incremental raw points = %d, want 1", second.RawPoints)
	}
	var maxTrack, cursor int64
	if err := db.SQL.QueryRow("SELECT MAX(id) FROM track_points WHERE receiver_id = 'rx-1'").Scan(&maxTrack); err != nil {
		t.Fatal(err)
	}
	if err := db.SQL.QueryRow("SELECT last_track_id FROM coverage_receiver_state WHERE receiver_id = 'rx-1'").Scan(&cursor); err != nil {
		t.Fatal(err)
	}
	if cursor != maxTrack {
		t.Fatalf("cursor = %d, want %d", cursor, maxTrack)
	}

	options.WindowHours = 24 * 30
	expanded, err := SyncCells(context.Background(), db.SQL, options, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if expanded.RawPoints != 6 {
		t.Fatalf("expanded raw points = %d, want 6", expanded.RawPoints)
	}
	if err := db.SQL.QueryRow("SELECT COUNT(*) FROM coverage_cells WHERE lat < 37.4").Scan(&oldCellCount); err != nil {
		t.Fatal(err)
	}
	if oldCellCount == 0 {
		t.Fatal("expanded window did not rebuild old cells")
	}
}

func TestRefreshBuildsMeshAndReusesUnchangedReceiverPartition(t *testing.T) {
	db := testCoverageDB(t)
	var points []trackPoint
	for index := 0; index < 8; index++ {
		points = append(points, trackPoint{
			positionAt: time.Date(2026, 7, 22, 23, 59, index*3, 0, time.UTC).Format(time.RFC3339Nano),
			lat:        37.5 + float64(index)*0.018,
			lon:        127 + float64(index)*0.018,
			altitude:   8000 + float64(index)*800,
		})
	}
	addTrackPoints(t, db, points)
	cache := make(ReceiverCache)
	now := time.Date(2026, 7, 23, 0, 0, 0, 0, time.UTC)
	first, aggregation, err := Refresh(context.Background(), db.SQL, testCoverageOptions(), now, cache)
	if err != nil {
		t.Fatal(err)
	}
	if aggregation.RawPoints != len(points) || first.ReceiverCount != 1 ||
		len(first.Areas) != 1 || first.Areas[0].VolumeMesh == nil {
		t.Fatalf("unexpected first snapshot: %#v / %#v", aggregation, first)
	}
	if len(cache) != 1 {
		t.Fatalf("receiver cache size = %d, want 1", len(cache))
	}
	second, unchanged, err := Refresh(context.Background(), db.SQL, testCoverageOptions(), now.Add(time.Minute), cache)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.RawPoints != 0 || second.Count != first.Count {
		t.Fatalf("unchanged refresh rebuilt data: %#v", unchanged)
	}
}

func TestCacheReusesCanonicalRepresentation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "skytrace.db")
	db, err := database.Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	cache, err := NewCache(path, testCoverageOptions(), 180)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cache.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := cache.Ready(ctx); err != nil {
		t.Fatal(err)
	}
	first, ok := cache.Representation()
	if !ok {
		t.Fatal("cache did not publish a representation")
	}
	var value map[string]any
	if err := json.Unmarshal(first.Identity, &value); err != nil {
		t.Fatal(err)
	}
	if value["contentGeneratedAt"] == nil || value["refreshIntervalSeconds"] != float64(180) {
		t.Fatalf("cache metadata = %#v", value)
	}
	if _, exists := value["from"]; exists {
		t.Fatal("volatile from timestamp was not removed")
	}
	if err := cache.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	second, ok := cache.Representation()
	if !ok || string(second.Identity) != string(first.Identity) ||
		second.IdentityETag != first.IdentityETag || second.GzipETag != first.GzipETag {
		t.Fatal("unchanged coverage did not reuse canonical bytes and validators")
	}
}
