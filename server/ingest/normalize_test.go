package ingest

import (
	"encoding/json"
	"testing"
	"time"
)

func TestNormalizeReadsbFields(t *testing.T) {
	payload := map[string]any{
		"now": json.Number("1760000000"),
		"aircraft": []any{map[string]any{
			"hex":          "ABC123",
			"flight":       "  TEST42 ",
			"lat":          json.Number("37.5"),
			"lon":          json.Number("127.1"),
			"alt_baro":     "ground",
			"gs":           json.Number("42.4"),
			"track":        json.Number("181"),
			"type":         "adsb_icao",
			"ias":          json.Number("120"),
			"tas":          json.Number("130"),
			"mach":         json.Number("0.21"),
			"true_heading": json.Number("182"),
			"wd":           json.Number("270"),
			"ws":           json.Number("15"),
			"nac_p":        json.Number("10"),
			"seen":         json.Number("2"),
			"seen_pos":     json.Number("3"),
			"messages":     "120",
		}},
	}
	receivedAt := time.Date(2025, 10, 9, 8, 53, 20, 0, time.UTC)
	result := NormalizePayload(payload, receivedAt, 120)
	if len(result.Aircraft) != 1 {
		t.Fatalf("aircraft = %#v", result.Aircraft)
	}
	aircraft := result.Aircraft[0]
	if aircraft.Hex != "abc123" || aircraft.Flight == nil || *aircraft.Flight != "TEST42" {
		t.Fatalf("aircraft = %#v", aircraft)
	}
	if !aircraft.OnGround || aircraft.AltBaro == nil || *aircraft.AltBaro != 0 {
		t.Fatalf("ground fields = %#v", aircraft)
	}
	if aircraft.Messages == nil || *aircraft.Messages != 120 || aircraft.SourceKind != "adsb" {
		t.Fatalf("source fields = %#v", aircraft)
	}
	if aircraft.PositionAt == nil || *aircraft.PositionAt != "2025-10-09T08:53:17.000Z" {
		t.Fatalf("positionAt = %#v", aircraft.PositionAt)
	}
}

func TestInvalidObservationAndPosition(t *testing.T) {
	payload := map[string]any{
		"aircraft": []any{
			map[string]any{"hex": "bad", "seen": json.Number("0")},
			map[string]any{
				"hex": "abc124", "lat": json.Number("137"), "lon": json.Number("127"),
				"seen": json.Number("0"), "seen_pos": json.Number("0"),
			},
		},
	}
	result := NormalizePayload(payload, time.Now(), 120)
	if len(result.Aircraft) != 1 || result.InvalidObservationCount != 1 {
		t.Fatalf("result = %#v", result)
	}
	if result.Aircraft[0].Lat != nil || result.Aircraft[0].Lon != nil {
		t.Fatalf("invalid position retained: %#v", result.Aircraft[0])
	}
}

func TestNonICAOTarget(t *testing.T) {
	result := NormalizePayload(map[string]any{
		"aircraft": []any{map[string]any{
			"hex": "~ab1234", "type": "tisb_trackfile", "seen": json.Number("0"),
		}},
	}, time.Now(), 120)
	if len(result.Aircraft) != 1 || !result.Aircraft[0].NonICAO || result.Aircraft[0].SourceKind != "tisb" {
		t.Fatalf("result = %#v", result)
	}
}

func TestReceiverIDAndFreshness(t *testing.T) {
	if value, ok := SanitizeReceiverID("roof-01"); !ok || value != "roof-01" {
		t.Fatalf("receiver = %q, %v", value, ok)
	}
	for _, value := range []string{"bad id", "../bad"} {
		if _, ok := SanitizeReceiverID(value); ok {
			t.Fatalf("accepted %q", value)
		}
	}
	if !IsFresh("2025-10-09T08:53:18.000Z", "2025-10-09T08:53:20.000Z", 120) {
		t.Fatal("fresh observation rejected")
	}
	if IsFresh("2025-10-09T08:40:00.000Z", "2025-10-09T08:53:20.000Z", 120) {
		t.Fatal("stale observation accepted")
	}
}
