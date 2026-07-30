package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/luftaquila/skytrace/server/database"
)

func testOptions() Options {
	return Options{
		ReceiverID:               "rx-1",
		ReceivedAt:               time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC),
		MaxObservationAgeSeconds: 120,
		TrackMinIntervalSeconds:  0,
		PositionFilterMaxMach:    3.5,
	}
}

func TestIngestTruncatesBeforeNormalization(t *testing.T) {
	db, err := database.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	aircraft := make([]any, 1001)
	for index := range aircraft {
		aircraft[index] = map[string]any{
			"hex":  fmt.Sprintf("%06x", index),
			"seen": json.Number("0"),
		}
	}
	result, err := Store(context.Background(), db.SQL, map[string]any{"aircraft": aircraft}, testOptions())
	if err != nil {
		t.Fatal(err)
	}
	if result.AircraftCount != 1001 || result.AcceptedCount != 1000 || result.TruncatedCount != 1 {
		t.Fatalf("result = %#v", result)
	}
}

func TestIngestRejectsBadSeenAndClearsBadPosition(t *testing.T) {
	db, err := database.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	payload := map[string]any{"aircraft": []any{
		map[string]any{
			"hex": "abc123", "seen": json.Number("-1"), "lat": json.Number("37"),
			"lon": json.Number("127"), "seen_pos": json.Number("0"),
		},
		map[string]any{
			"hex": "def456", "seen": json.Number("0"), "lat": json.Number("37"),
			"lon": json.Number("127"), "seen_pos": json.Number("121"), "gs": json.Number("200"),
		},
	}}
	result, err := Store(context.Background(), db.SQL, payload, testOptions())
	if err != nil {
		t.Fatal(err)
	}
	if result.AcceptedCount != 1 || result.InvalidObservationCount != 1 {
		t.Fatalf("result = %#v", result)
	}
	var hex string
	var positionAt, lat, lon any
	if err := db.SQL.QueryRow(
		"SELECT hex, position_at, lat, lon FROM receiver_aircraft_current",
	).Scan(&hex, &positionAt, &lat, &lon); err != nil {
		t.Fatal(err)
	}
	if hex != "def456" || positionAt != nil || lat != nil || lon != nil {
		t.Fatalf("row = %q %#v %#v %#v", hex, positionAt, lat, lon)
	}
}

func TestTrackBudgetDoesNotDropCurrent(t *testing.T) {
	db, err := database.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	options := testOptions()
	options.ConsumeTrackBudget = func(string) bool { return false }
	result, err := Store(context.Background(), db.SQL, map[string]any{
		"aircraft": []any{map[string]any{
			"hex": "abc123", "seen": json.Number("0"), "seen_pos": json.Number("0"),
			"lat": json.Number("37.5"), "lon": json.Number("127.1"),
		}},
	}, options)
	if err != nil {
		t.Fatal(err)
	}
	if result.AcceptedCount != 1 || result.TrackPoints != 0 || result.TrackBudgetDroppedCount != 1 {
		t.Fatalf("result = %#v", result)
	}
	var current, tracks int
	if err := db.SQL.QueryRow("SELECT count(*) FROM receiver_aircraft_current").Scan(&current); err != nil {
		t.Fatal(err)
	}
	if err := db.SQL.QueryRow("SELECT count(*) FROM track_points").Scan(&tracks); err != nil {
		t.Fatal(err)
	}
	if current != 1 || tracks != 0 {
		t.Fatalf("current=%d tracks=%d", current, tracks)
	}
}

func TestAuthenticate(t *testing.T) {
	db, err := database.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	token := strings.Repeat("a", 32)
	if _, err := db.SQL.Exec("INSERT INTO receivers (id) VALUES ('rx-1')"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL.Exec(
		"INSERT INTO receiver_tokens (receiver_id, token_hash) VALUES ('rx-1', ?)",
		database.HashToken(token),
	); err != nil {
		t.Fatal(err)
	}
	result, err := Authenticate(context.Background(), db.SQL, token, "rx-1")
	if err != nil || !result.OK || result.ReceiverID != "rx-1" {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	result, err = Authenticate(context.Background(), db.SQL, token, "rx-2")
	if err != nil || result.OK || result.Reason != "invalid token" {
		t.Fatalf("result=%#v err=%v", result, err)
	}
}
