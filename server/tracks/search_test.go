package tracks

import (
	"context"
	"testing"
	"time"

	"github.com/luftaquila/skytrace/server/database"
)

func searchTestDB(t *testing.T) *database.DB {
	t.Helper()
	ctx := context.Background()
	db, err := database.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.SQL.Exec("INSERT INTO receivers (id) VALUES ('rx-1'), ('rx-2')"); err != nil {
		t.Fatal(err)
	}
	seed := []struct {
		hex, receiver, flight, observedAt string
	}{
		{"abc123", "rx-1", "KAL123", "2026-08-24T01:00:00.000Z"},
		{"abc123", "rx-2", "KAL123", "2026-08-24T02:00:00.000Z"},
		{"abc999", "rx-1", "KAL999", "2026-08-24T03:00:00.000Z"},
		{"def456", "rx-1", "AAR777", "2026-08-24T04:00:00.000Z"},
	}
	for _, row := range seed {
		if _, err := db.SQL.Exec(`
			INSERT INTO receiver_aircraft_current (receiver_id, hex, observed_at, flight)
			VALUES (?, ?, ?, ?)
		`, row.receiver, row.hex, row.observedAt, row.flight); err != nil {
			t.Fatal(err)
		}
	}
	points := []struct {
		hex, positionAt string
	}{
		{"abc123", "2026-08-20T10:00:00.000Z"},
		{"abc123", "2026-08-24T01:59:00.000Z"},
		{"aa0001", "2026-08-01T00:00:00.000Z"}, // track archive only: no current row
		{"aa0001", "2026-08-02T00:00:00.000Z"},
	}
	for _, row := range points {
		if _, err := db.SQL.Exec(`
			INSERT INTO track_points (hex, receiver_id, observed_at, position_at, lat, lon)
			VALUES (?, 'rx-1', ?, ?, 37.5, 127.1)
		`, row.hex, row.positionAt, row.positionAt); err != nil {
			t.Fatal(err)
		}
	}
	return db
}

func TestSearchAircraftByCallsign(t *testing.T) {
	db := searchTestDB(t)
	results, err := SearchAircraft(context.Background(), db.SQL, "kal", testSearchNow())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 {
		t.Fatalf("results = %#v", results)
	}
	// Newest callsign sighting first.
	if results[0].Hex != "abc999" || results[1].Hex != "abc123" {
		t.Fatalf("order = %s, %s", results[0].Hex, results[1].Hex)
	}
	first := results[1]
	if first.Flight == nil || *first.Flight != "KAL123" || !first.HasTrack {
		t.Fatalf("callsign row = %#v", first)
	}
	// The track archive span backfills first seen and keeps the newest last seen.
	if first.FirstSeenAt == nil || *first.FirstSeenAt != "2026-08-20T10:00:00.000Z" {
		t.Fatalf("firstSeenAt = %v", first.FirstSeenAt)
	}
	if first.LastSeenAt != "2026-08-24T02:00:00.000Z" {
		t.Fatalf("lastSeenAt = %s", first.LastSeenAt)
	}
}

func TestSearchAircraftByHexPrefixFindsArchiveOnlyAircraft(t *testing.T) {
	db := searchTestDB(t)
	results, err := SearchAircraft(context.Background(), db.SQL, "AA00", testSearchNow())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Hex != "aa0001" {
		t.Fatalf("results = %#v", results)
	}
	if results[0].Flight != nil || !results[0].HasTrack {
		t.Fatalf("archive-only row = %#v", results[0])
	}
	if results[0].LastSeenAt != "2026-08-02T00:00:00.000Z" {
		t.Fatalf("lastSeenAt = %s", results[0].LastSeenAt)
	}
}

func TestSearchAircraftDeduplicatesAcrossBranches(t *testing.T) {
	db := searchTestDB(t)
	// "abc" is a hex prefix AND could hit callsigns; abc123 must come back once,
	// carrying its callsign.
	results, err := SearchAircraft(context.Background(), db.SQL, "abc1", testSearchNow())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Hex != "abc123" {
		t.Fatalf("results = %#v", results)
	}
	if results[0].Flight == nil || *results[0].Flight != "KAL123" {
		t.Fatalf("flight = %v", results[0].Flight)
	}
}

func testSearchNow() time.Time {
	return time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
}

func TestSearchAircraftRejectsOverlongQueries(t *testing.T) {
	db := searchTestDB(t)
	if _, err := SearchAircraft(context.Background(), db.SQL, "12345678901234567", testSearchNow()); err == nil {
		t.Fatal("accepted an overlong query")
	}
	// LIKE metacharacters must stay literal, not widen the scan.
	results, err := SearchAircraft(context.Background(), db.SQL, "%%", testSearchNow())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("wildcard leaked: %#v", results)
	}
}

func TestSearchAircraftEmptyQueryBrowsesDepartedFlights(t *testing.T) {
	db := searchTestDB(t)
	// One aircraft is still on the live picture and must not appear in the browse.
	if _, err := db.SQL.Exec(`
		INSERT INTO receiver_aircraft_current (receiver_id, hex, observed_at, flight)
		VALUES ('rx-1', 'eee111', '2026-08-24T11:59:30.000Z', 'LIVE01')
	`); err != nil {
		t.Fatal(err)
	}
	results, err := SearchAircraft(context.Background(), db.SQL, "", testSearchNow())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 3 {
		t.Fatalf("results = %#v", results)
	}
	for _, result := range results {
		if result.Hex == "eee111" {
			t.Fatalf("live aircraft leaked into the departed browse: %#v", results)
		}
	}
	// Newest departure first.
	if results[0].Hex != "def456" || results[0].Flight == nil || *results[0].Flight != "AAR777" {
		t.Fatalf("first = %#v", results[0])
	}
}
