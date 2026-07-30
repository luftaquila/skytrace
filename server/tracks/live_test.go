package tracks

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/luftaquila/skytrace/server/database"
	"github.com/luftaquila/skytrace/server/ingest"
)

func TestCurrentAircraftAndHistory(t *testing.T) {
	ctx := context.Background()
	db, err := database.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	_, err = ingest.Store(ctx, db.SQL, map[string]any{
		"aircraft": []any{map[string]any{
			"hex": "abc123", "flight": "TEST1", "seen": json.Number("0"),
			"seen_pos": json.Number("0"), "lat": json.Number("37.5"),
			"lon": json.Number("127.1"), "alt_baro": json.Number("12000"),
			"gs": json.Number("250"), "type": "adsb_icao",
		}},
	}, ingest.Options{
		ReceiverID: "rx-1", ReceivedAt: now, MaxObservationAgeSeconds: 120,
		TrackMinIntervalSeconds: 0, PositionFilterMaxMach: 3.5,
	})
	if err != nil {
		t.Fatal(err)
	}
	current, err := CurrentAircraft(ctx, db.SQL, now, 120*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if current.Count != 1 || current.Aircraft[0].Hex != "abc123" ||
		current.Aircraft[0].Lat == nil || *current.Aircraft[0].Lat != 37.5 {
		t.Fatalf("current = %#v", current)
	}
	if current.Summary.WithPosition != 1 || current.Summary.Sources["adsb"] != 1 {
		t.Fatalf("summary = %#v", current.Summary)
	}

	history, err := AircraftHistory(ctx, db.SQL, "ABC123", HistoryOptions{
		Now: now, RetentionDays: 90, Limit: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(history.Points) != 1 || history.Points[0].Hex != "abc123" || history.LiveCursorID == nil {
		t.Fatalf("history = %#v", history)
	}
	if kml := TrackKML(history.Hex, history.Points); !containsAll(kml, "ABC123", "127.1,37.5,12000") {
		t.Fatalf("KML = %s", kml)
	}
}

func TestHistoryPagination(t *testing.T) {
	ctx := context.Background()
	db, err := database.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.SQL.Exec("INSERT INTO receivers (id) VALUES ('rx-1')"); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 3; index++ {
		at := time.Date(2026, 7, 28, 12, 0, index, 0, time.UTC).Format("2006-01-02T15:04:05.000Z")
		if _, err := db.SQL.Exec(`
			INSERT INTO track_points (
			  hex, receiver_id, observed_at, position_at, lat, lon
			) VALUES ('abc123', 'rx-1', ?, ?, 37.5, 127.1)
		`, at, at); err != nil {
			t.Fatal(err)
		}
	}
	first, err := AircraftHistory(ctx, db.SQL, "abc123", HistoryOptions{
		Now: time.Date(2026, 7, 28, 12, 1, 0, 0, time.UTC), RetentionDays: 90, Limit: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Points) != 2 || !first.HasOlder || first.OlderCursor == nil {
		t.Fatalf("first = %#v", first)
	}
	second, err := AircraftHistory(ctx, db.SQL, "abc123", HistoryOptions{
		Now: time.Date(2026, 7, 28, 12, 1, 0, 0, time.UTC), RetentionDays: 90,
		Limit: 2, OlderCursor: *first.OlderCursor,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Points) != 1 || second.HasOlder {
		t.Fatalf("second = %#v", second)
	}

	now := time.Date(2026, 7, 28, 12, 1, 0, 0, time.UTC)
	expired := encodeCursor(cursor{
		ID: 999999, Hex: "abc123",
		At: iso(now.Add(-91 * 24 * time.Hour)),
	})
	_, err = AircraftHistory(ctx, db.SQL, "abc123", HistoryOptions{
		Now: now, RetentionDays: 90, OlderCursor: expired,
	})
	queryError, ok := err.(*QueryError)
	if !ok || queryError.Status != 410 {
		t.Fatalf("expired cursor error = %#v", err)
	}
	_, err = AircraftHistory(ctx, db.SQL, "abc123", HistoryOptions{
		Now: now, RetentionDays: 90, OlderCursor: "invalid",
	})
	queryError, ok = err.(*QueryError)
	if !ok || queryError.Status != 400 {
		t.Fatalf("invalid cursor error = %#v", err)
	}
	outside := now.Add(time.Minute)
	_, err = AircraftHistory(ctx, db.SQL, "abc123", HistoryOptions{
		Now: now, RetentionDays: 90, At: &outside,
	})
	queryError, ok = err.(*QueryError)
	if !ok || queryError.Status != 400 {
		t.Fatalf("future at error = %#v", err)
	}
}

func containsAll(value string, values ...string) bool {
	for _, item := range values {
		if !strings.Contains(value, item) {
			return false
		}
	}
	return true
}
