package tracks

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/luftaquila/skytrace/internal/database"
)

func TestNormalizeBulkRequest(t *testing.T) {
	request, ok := NormalizeBulkRequest(map[string]any{
		"aircraft": []any{map[string]any{"hex": "ABC123", "afterId": json.Number("1")}},
		"detail":   "abc123",
	})
	if !ok || len(request.Aircraft) != 1 || request.Aircraft[0].Hex != "abc123" {
		t.Fatalf("request = %#v, ok=%v", request, ok)
	}
	for _, invalid := range []any{
		map[string]any{},
		map[string]any{"aircraft": []any{}, "legacy": true},
		map[string]any{"aircraft": []any{map[string]any{"hex": "bad", "afterId": json.Number("1")}}},
		map[string]any{"aircraft": []any{map[string]any{"hex": "abc123", "afterId": json.Number("0")}}},
	} {
		if _, ok := NormalizeBulkRequest(invalid); ok {
			t.Fatalf("accepted %#v", invalid)
		}
	}
	tooMany := make([]any, 33)
	for index := range tooMany {
		tooMany[index] = map[string]any{
			"hex":     "abc123",
			"afterId": json.Number("1"),
		}
	}
	if _, ok := NormalizeBulkRequest(map[string]any{"aircraft": tooMany}); ok {
		t.Fatal("accepted more than 32 aircraft")
	}
}

func TestBulkTracks(t *testing.T) {
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
	var firstID int64
	if err := db.SQL.QueryRow("SELECT min(id) FROM track_points").Scan(&firstID); err != nil {
		t.Fatal(err)
	}
	response, err := BulkTracks(ctx, db.SQL, BulkRequest{
		Aircraft: []BulkAircraftRequest{{Hex: "abc123", AfterID: firstID}},
		Detail:   "abc123",
	}, time.Date(2026, 7, 28, 12, 1, 0, 0, time.UTC), 24)
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Tracks) != 1 || len(response.Tracks[0].Points) != 2 ||
		response.Tracks[0].ResetRequired {
		t.Fatalf("response = %#v", response)
	}

	reset, err := BulkTracks(ctx, db.SQL, BulkRequest{
		Aircraft: []BulkAircraftRequest{{Hex: "abc123", AfterID: 999999}},
	}, time.Date(2026, 7, 28, 12, 1, 0, 0, time.UTC), 24)
	if err != nil {
		t.Fatal(err)
	}
	if len(reset.Tracks) != 1 || !reset.Tracks[0].ResetRequired {
		t.Fatalf("reset response = %#v", reset)
	}
}
