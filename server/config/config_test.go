package config

import (
	"path/filepath"
	"strings"
	"testing"
)

const testToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestDefaults(t *testing.T) {
	config, err := Load(map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	if config.Port != 3000 || config.CurrentWindowSeconds != 90 {
		t.Fatalf("unexpected defaults: %#v", config)
	}
	if config.CoverageWindowHours != 720 || config.TrackRetentionDays != 90 {
		t.Fatalf("unexpected retention defaults: %#v", config)
	}
	if !filepath.IsAbs(config.DBPath) || !filepath.IsAbs(config.StaticDir) {
		t.Fatalf("paths are not absolute: %#v", config)
	}
}

func TestReceiverTokens(t *testing.T) {
	config, err := Load(map[string]string{
		"SKYTRACE_RECEIVER_TOKENS": `{"rx-2":"` + testToken[1:] + `0","rx-1":"` + testToken + `"}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(config.ReceiverTokens) != 2 || config.ReceiverTokens[0].ReceiverID != "rx-1" {
		t.Fatalf("tokens = %#v", config.ReceiverTokens)
	}

	for _, raw := range []string{
		`[]`,
		`null`,
		`{"../bad":"` + testToken + `"}`,
		`{"rx":"short"}`,
		`{"rx-1":"` + testToken + `","rx-2":"` + testToken + `"}`,
	} {
		if _, err := Load(map[string]string{"SKYTRACE_RECEIVER_TOKENS": raw}); err == nil {
			t.Errorf("accepted invalid tokens: %s", raw)
		}
	}
}

func TestStrictValues(t *testing.T) {
	tests := []struct {
		key   string
		value string
		match string
	}{
		{"PORT", "1.5", "expected an integer"},
		{"PORT", "65536", "0 to 65535"},
		{"SKYTRACE_LIVE_MAX_AIRCRAFT", "99", "100 to 20000"},
		{"SKYTRACE_POSITION_FILTER_MAX_MACH", "NaN", "expected a number"},
		{"SKYTRACE_INGEST_TOKEN", "legacy", "was removed"},
		{"SKYTRACE_TRUST_PROXY", "true", "not a boolean"},
		{"SKYTRACE_TRUST_PROXY", "1", "positive hop counts"},
		{"SKYTRACE_TRUST_PROXY", "bad", "IP/CIDR"},
	}
	for _, test := range tests {
		t.Run(test.key+"="+test.value, func(t *testing.T) {
			_, err := Load(map[string]string{test.key: test.value})
			if err == nil || !strings.Contains(err.Error(), test.match) {
				t.Fatalf("error = %v, want containing %q", err, test.match)
			}
		})
	}
}

func TestRetentionMustCoverCoverage(t *testing.T) {
	_, err := Load(map[string]string{
		"SKYTRACE_COVERAGE_WINDOW_HOURS": "720",
		"SKYTRACE_TRACK_RETENTION_DAYS":  "30",
	})
	if err == nil || !strings.Contains(err.Error(), "at least 31") {
		t.Fatalf("error = %v", err)
	}
}

func TestTrustProxy(t *testing.T) {
	config, err := Load(map[string]string{
		"SKYTRACE_TRUST_PROXY": "127.0.0.1/32, ::1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(config.TrustProxy) != 2 || !config.TrustProxy[0].Contains(config.TrustProxy[0].Addr()) {
		t.Fatalf("trust proxy = %#v", config.TrustProxy)
	}
}
