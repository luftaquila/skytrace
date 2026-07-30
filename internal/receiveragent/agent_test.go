package receiveragent

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testConfig() Config {
	return Config{
		IngestURL:       "https://sky.example.test/api/ingest/readsb",
		Token:           testToken,
		Interval:        DefaultInterval,
		AircraftURL:     "http://127.0.0.1/aircraft.json",
		Receiver:        Receiver{ID: "rx-1", Name: "Receiver", PublicName: "Public"},
		AircraftTimeout: AircraftTimeout,
		IngestTimeout:   IngestTimeout,
	}
}

func TestRunOnceUploadsRawPayload(t *testing.T) {
	aircraft := `{"now":1234.5,"aircraft":[{"hex":"abc123","flight":"SMOKE1"}]}`
	mux := http.NewServeMux()
	server := httptest.NewServer(mux)
	defer server.Close()

	mux.HandleFunc("/aircraft.json", func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Cache-Control") != "no-store" {
			t.Errorf("cache control = %q", request.Header.Get("Cache-Control"))
		}
		fmt.Fprint(response, aircraft)
	})
	mux.HandleFunc("/api/ingest/readsb", func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+testToken {
			t.Errorf("authorization = %q", request.Header.Get("Authorization"))
		}
		if request.Header.Get("X-Skytrace-Receiver") != "rx-1" {
			t.Errorf("receiver header = %q", request.Header.Get("X-Skytrace-Receiver"))
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		var envelope struct {
			Receiver Receiver        `json:"receiver"`
			Payload  json.RawMessage `json:"payload"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil {
			t.Fatal(err)
		}
		if string(envelope.Payload) != aircraft {
			t.Errorf("payload = %s", envelope.Payload)
		}
		response.Header().Set("Content-Type", "application/json")
		fmt.Fprint(response, `{"receiverId":"rx-1","acceptedCount":1,"trackPoints":1,"receivedAt":"2026-01-02T03:04:05.000Z"}`)
	})

	config := testConfig()
	config.AircraftURL = server.URL + "/aircraft.json"
	config.IngestURL = server.URL + "/api/ingest/readsb"
	agent := New(config, server.Client(), io.Discard, io.Discard)
	result, err := agent.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.AcceptedCount != 1 || result.TrackPoints != 1 || result.ReceiverID != "rx-1" {
		t.Fatalf("result = %#v", result)
	}
}

func TestRedirectsAreRefusedWithoutCredentialLeak(t *testing.T) {
	var redirectedRequests atomic.Int32
	redirectTarget := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		redirectedRequests.Add(1)
	}))
	defer redirectTarget.Close()

	redirector := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		http.Redirect(response, request, redirectTarget.URL, http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()

	client, err := NewHTTPClient("")
	if err != nil {
		t.Fatal(err)
	}
	config := testConfig()
	config.AircraftURL = redirector.URL
	agent := New(config, client, io.Discard, io.Discard)
	if _, err := agent.ReadAircraftJSON(context.Background()); err == nil || !strings.Contains(err.Error(), "redirected") {
		t.Fatalf("aircraft redirect error = %v", err)
	}

	config.AircraftURL = ""
	config.AircraftFile = writeAircraftFile(t, `{"aircraft":[]}`)
	config.IngestURL = redirector.URL
	agent = New(config, client, io.Discard, io.Discard)
	if _, err := agent.RunOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "redirect refused") {
		t.Fatalf("ingest redirect error = %v", err)
	}
	if redirectedRequests.Load() != 0 {
		t.Fatalf("redirect target received %d requests", redirectedRequests.Load())
	}
}

func TestBodyLimitsAndInvalidJSON(t *testing.T) {
	tests := []struct {
		name    string
		handler http.HandlerFunc
		match   error
	}{
		{
			name: "declared oversized",
			handler: func(response http.ResponseWriter, _ *http.Request) {
				response.Header().Set("Content-Length", fmt.Sprint(MaxAircraftBytes+1))
			},
			match: ErrBodyTooLarge,
		},
		{
			name: "streamed oversized",
			handler: func(response http.ResponseWriter, _ *http.Request) {
				response.WriteHeader(http.StatusOK)
				_, _ = io.CopyN(response, zeroReader{}, MaxAircraftBytes+1)
			},
			match: ErrBodyTooLarge,
		},
		{
			name: "invalid JSON",
			handler: func(response http.ResponseWriter, _ *http.Request) {
				fmt.Fprint(response, "{")
			},
			match: ErrInvalidJSON,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(test.handler)
			defer server.Close()
			config := testConfig()
			config.AircraftURL = server.URL
			agent := New(config, server.Client(), io.Discard, io.Discard)
			_, err := agent.ReadAircraftJSON(context.Background())
			if !errors.Is(err, test.match) {
				t.Fatalf("error = %v, want %v", err, test.match)
			}
		})
	}
}

func TestFileLimitsAndInvalidJSON(t *testing.T) {
	config := testConfig()
	config.AircraftURL = ""
	config.AircraftFile = writeAircraftFile(t, "{")
	agent := New(config, http.DefaultClient, io.Discard, io.Discard)
	if _, err := agent.ReadAircraftJSON(context.Background()); !errors.Is(err, ErrInvalidJSON) {
		t.Fatalf("invalid JSON error = %v", err)
	}

	oversized := filepath.Join(t.TempDir(), "oversized.json")
	file, err := os.Create(oversized)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(MaxAircraftBytes + 1); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	config.AircraftFile = oversized
	agent = New(config, http.DefaultClient, io.Discard, io.Discard)
	if _, err := agent.ReadAircraftJSON(context.Background()); !errors.Is(err, ErrBodyTooLarge) {
		t.Fatalf("oversized error = %v", err)
	}
}

func TestAircraftRequestTimesOut(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		time.Sleep(100 * time.Millisecond)
	}))
	defer server.Close()
	config := testConfig()
	config.AircraftURL = server.URL
	config.AircraftTimeout = 5 * time.Millisecond
	agent := New(config, server.Client(), io.Discard, io.Discard)
	_, err := agent.ReadAircraftJSON(context.Background())
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v", err)
	}
	if ErrorClass(err) != "timeout" {
		t.Fatalf("class = %q", ErrorClass(err))
	}
}

func TestIngestResponseLimitsTimeoutAndStatus(t *testing.T) {
	payload := json.RawMessage(`{"aircraft":[]}`)
	tests := []struct {
		name    string
		handler http.HandlerFunc
		timeout time.Duration
		match   error
		class   string
	}{
		{
			name: "declared oversized response",
			handler: func(response http.ResponseWriter, _ *http.Request) {
				response.Header().Set("Content-Length", fmt.Sprint(MaxResponseBytes+1))
			},
			match: ErrBodyTooLarge,
			class: "body-too-large",
		},
		{
			name: "streamed oversized response",
			handler: func(response http.ResponseWriter, _ *http.Request) {
				response.WriteHeader(http.StatusOK)
				_, _ = io.CopyN(response, zeroReader{}, MaxResponseBytes+1)
			},
			match: ErrBodyTooLarge,
			class: "body-too-large",
		},
		{
			name: "timeout",
			handler: func(http.ResponseWriter, *http.Request) {
				time.Sleep(100 * time.Millisecond)
			},
			timeout: 5 * time.Millisecond,
			match:   context.DeadlineExceeded,
			class:   "timeout",
		},
		{
			name: "HTTP status",
			handler: func(response http.ResponseWriter, _ *http.Request) {
				http.Error(response, "unavailable", http.StatusServiceUnavailable)
			},
			class: "HTTP 503",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(test.handler)
			defer server.Close()
			config := testConfig()
			config.IngestURL = server.URL
			if test.timeout != 0 {
				config.IngestTimeout = test.timeout
			}
			agent := New(config, server.Client(), io.Discard, io.Discard)
			_, err := agent.PostBatch(context.Background(), payload)
			if err == nil {
				t.Fatal("PostBatch succeeded")
			}
			if test.match != nil && !errors.Is(err, test.match) {
				t.Fatalf("error = %v, want %v", err, test.match)
			}
			if class := ErrorClass(err); class != test.class {
				t.Fatalf("class = %q, want %q", class, test.class)
			}
		})
	}
}

func TestPostBatchRejectsOversizedEnvelope(t *testing.T) {
	payload := make([]byte, MaxAircraftBytes)
	for index := range payload {
		payload[index] = ' '
	}
	payload[len(payload)-2] = '{'
	payload[len(payload)-1] = '}'
	agent := New(testConfig(), http.DefaultClient, io.Discard, io.Discard)
	if _, err := agent.PostBatch(context.Background(), json.RawMessage(payload)); !errors.Is(err, ErrBodyTooLarge) {
		t.Fatalf("error = %v", err)
	}
}

func TestCustomCAFile(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(response, `{"aircraft":[]}`)
	}))
	defer server.Close()

	certificate, err := x509.ParseCertificate(server.Certificate().Raw)
	if err != nil {
		t.Fatal(err)
	}
	caFile := filepath.Join(t.TempDir(), "ca.pem")
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Raw})
	if err := os.WriteFile(caFile, pemBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := NewHTTPClient(caFile)
	if err != nil {
		t.Fatal(err)
	}
	config := testConfig()
	config.AircraftURL = server.URL
	agent := New(config, client, io.Discard, io.Discard)
	if _, err := agent.ReadAircraftJSON(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestRunBackoffAndBoundedErrorLog(t *testing.T) {
	config := testConfig()
	config.Interval = time.Second
	config.AircraftURL = "://bad"
	var sleeps []time.Duration
	var stderr strings.Builder
	agent := New(config, http.DefaultClient, io.Discard, &stderr)
	agent.Now = func() time.Time { return time.Unix(0, 0) }
	agent.Jitter = func(time.Duration) time.Duration { return 0 }
	agent.Sleep = func(_ context.Context, duration time.Duration) error {
		sleeps = append(sleeps, duration)
		if len(sleeps) == 2 {
			return context.Canceled
		}
		return nil
	}
	err := agent.Run(context.Background(), false)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v", err)
	}
	if len(sleeps) != 2 || sleeps[0] != 2*time.Second || sleeps[1] != 4*time.Second {
		t.Fatalf("sleeps = %v", sleeps)
	}
	if strings.Contains(stderr.String(), testToken) || strings.Contains(stderr.String(), "://bad") {
		t.Fatalf("sensitive or unbounded error log: %q", stderr.String())
	}
	if strings.Count(stderr.String(), "request-failed") != 2 {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func writeAircraftFile(t *testing.T, contents string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "aircraft.json")
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

type zeroReader struct{}

func (zeroReader) Read(buffer []byte) (int, error) {
	for index := range buffer {
		buffer[index] = ' '
	}
	return len(buffer), nil
}
