package receiveragent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func baseEnvironment() map[string]string {
	return map[string]string{
		"SKYTRACE_SERVER_URL":   "https://sky.example.test",
		"SKYTRACE_RECEIVER_ID":  "rx-1",
		"SKYTRACE_TOKEN":        testToken,
		"SKYTRACE_AIRCRAFT_URL": "http://127.0.0.1:8080/data/aircraft.json",
	}
}

func cloneEnvironment(source map[string]string) map[string]string {
	clone := make(map[string]string, len(source))
	for key, value := range source {
		clone[key] = value
	}
	return clone
}

func TestLoadConfig(t *testing.T) {
	config, err := LoadConfig(baseEnvironment())
	if err != nil {
		t.Fatal(err)
	}
	if config.Interval != 3*time.Second {
		t.Fatalf("interval = %s", config.Interval)
	}
	if config.IngestURL != "https://sky.example.test/api/ingest/readsb" {
		t.Fatalf("ingest URL = %q", config.IngestURL)
	}
	if config.Receiver.Name != "rx-1" || config.Receiver.PublicName != "rx-1" {
		t.Fatalf("receiver defaults = %#v", config.Receiver)
	}

	withBasePath := cloneEnvironment(baseEnvironment())
	withBasePath["SKYTRACE_SERVER_URL"] = "http://localhost:3000/base/"
	config, err = LoadConfig(withBasePath)
	if err != nil {
		t.Fatal(err)
	}
	if config.IngestURL != "http://localhost:3000/base/api/ingest/readsb" {
		t.Fatalf("base-path ingest URL = %q", config.IngestURL)
	}
}

func TestLoadConfigRejectsInvalidValues(t *testing.T) {
	tests := []struct {
		name  string
		key   string
		value string
		match string
	}{
		{"short interval", "SKYTRACE_INTERVAL_MS", "999", "1000 to 60000"},
		{"large interval", "SKYTRACE_INTERVAL_MS", "60001", "1000 to 60000"},
		{"decimal interval", "SKYTRACE_INTERVAL_MS", "1.5", "integer"},
		{"remote HTTP", "SKYTRACE_SERVER_URL", "http://192.0.2.1", "must use HTTPS"},
		{"credentials", "SKYTRACE_SERVER_URL", "https://user:pass@example.test", "credentials"},
		{"invalid scheme", "SKYTRACE_SERVER_URL", "file:///tmp/server", "invalid"},
		{"bad insecure flag", "SKYTRACE_ALLOW_INSECURE_SERVER", "true", "must be 1"},
		{"removed flag", "SKYTRACE_RECEIVER_PUBLIC_POSITION", "1", "was removed"},
		{"short token", "SKYTRACE_TOKEN", "short", "at least 32"},
		{"bad receiver", "SKYTRACE_RECEIVER_ID", "../bad", "invalid"},
		{"bad latitude", "SKYTRACE_RECEIVER_LAT", "91", "invalid"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			env := cloneEnvironment(baseEnvironment())
			env[test.key] = test.value
			_, err := LoadConfig(env)
			if err == nil || !strings.Contains(err.Error(), test.match) {
				t.Fatalf("error = %v, want containing %q", err, test.match)
			}
		})
	}
}

func TestLoadConfigRequiresExactlyOneSource(t *testing.T) {
	env := cloneEnvironment(baseEnvironment())
	env["SKYTRACE_AIRCRAFT_FILE"] = "/tmp/aircraft.json"
	if _, err := LoadConfig(env); err == nil || !strings.Contains(err.Error(), "exactly one") {
		t.Fatalf("both sources error = %v", err)
	}
	env["SKYTRACE_AIRCRAFT_URL"] = ""
	if _, err := LoadConfig(env); err != nil {
		t.Fatalf("file source: %v", err)
	}
	env["SKYTRACE_AIRCRAFT_FILE"] = ""
	if _, err := LoadConfig(env); err == nil || !strings.Contains(err.Error(), "exactly one") {
		t.Fatalf("no source error = %v", err)
	}
}

func TestLoadConfigSupportsLoopbackAndExplicitLANHTTP(t *testing.T) {
	for _, serverURL := range []string{
		"http://localhost:3000",
		"http://127.0.0.2:3000",
		"http://[::1]:3000",
	} {
		env := cloneEnvironment(baseEnvironment())
		env["SKYTRACE_SERVER_URL"] = serverURL
		if _, err := LoadConfig(env); err != nil {
			t.Errorf("%s: %v", serverURL, err)
		}
	}
	env := cloneEnvironment(baseEnvironment())
	env["SKYTRACE_SERVER_URL"] = "http://192.0.2.1"
	env["SKYTRACE_ALLOW_INSECURE_SERVER"] = "1"
	config, err := LoadConfig(env)
	if err != nil {
		t.Fatal(err)
	}
	if !config.InsecureServer {
		t.Fatal("explicit remote HTTP must be marked insecure")
	}
}

func TestCAFileCompatibility(t *testing.T) {
	env := cloneEnvironment(baseEnvironment())
	env["NODE_EXTRA_CA_CERTS"] = "/legacy/ca.pem"
	config, err := LoadConfig(env)
	if err != nil || config.CAFile != "/legacy/ca.pem" {
		t.Fatalf("legacy CA: config=%#v err=%v", config, err)
	}
	env["SKYTRACE_CA_FILE"] = "/new/ca.pem"
	if _, err := LoadConfig(env); err == nil || !strings.Contains(err.Error(), "must match") {
		t.Fatalf("conflicting CA error = %v", err)
	}
	env["NODE_EXTRA_CA_CERTS"] = "/new/ca.pem"
	config, err = LoadConfig(env)
	if err != nil || config.CAFile != "/new/ca.pem" {
		t.Fatalf("matching CA: config=%#v err=%v", config, err)
	}
}

func TestNewHTTPClientRejectsInvalidCAFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(path, []byte("not a certificate"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewHTTPClient(path); err == nil || !strings.Contains(err.Error(), "no certificates") {
		t.Fatalf("error = %v", err)
	}
}
