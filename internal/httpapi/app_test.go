package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/luftaquila/skytrace/internal/config"
	"github.com/luftaquila/skytrace/internal/coverage"
	"github.com/luftaquila/skytrace/internal/database"
)

func TestHealthAndSecurityHeaders(t *testing.T) {
	db, err := database.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	cfg, err := config.Load(map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	app, err := New(db.SQL, cfg, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(app)
	defer server.Close()

	response, err := server.Client().Get(server.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("cache control = %q", response.Header.Get("Cache-Control"))
	}
	if response.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("security headers = %#v", response.Header)
	}
}

func TestIngestLiveAndHistoryHTTP(t *testing.T) {
	ctx := context.Background()
	db, err := database.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	token := strings.Repeat("a", 64)
	cfg, err := config.Load(map[string]string{
		"SKYTRACE_RECEIVER_TOKENS":            `{"rx-1":"` + token + `"}`,
		"SKYTRACE_TRACK_MIN_INTERVAL_SECONDS": "0",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SyncReceiverTokens(ctx, db.SQL, cfg.ReceiverTokens, time.Now()); err != nil {
		t.Fatal(err)
	}
	app, err := New(db.SQL, cfg, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(app)
	defer server.Close()

	payload := []byte(`{
		"receiver":{"id":"rx-1","name":"Receiver"},
		"payload":{"now":1760000000,"aircraft":[{
			"hex":"abc123","flight":"TEST1","seen":0,"seen_pos":0,
			"lat":37.5,"lon":127.1,"alt_baro":12000,"gs":250,"type":"adsb_icao"
		}]}
	}`)
	request, err := http.NewRequest(http.MethodPost, server.URL+"/api/ingest/readsb", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-Skytrace-Receiver", "rx-1")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("ingest status=%d body=%s", response.StatusCode, body)
	}
	var ingestResult map[string]any
	if err := json.Unmarshal(body, &ingestResult); err != nil {
		t.Fatal(err)
	}
	if ingestResult["ok"] != true || ingestResult["acceptedCount"] != float64(1) {
		t.Fatalf("ingest = %#v", ingestResult)
	}

	response, err = server.Client().Get(server.URL + "/api/live")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !bytes.Contains(body, []byte(`"hex":"abc123"`)) {
		t.Fatalf("live status=%d body=%s", response.StatusCode, body)
	}

	response, err = server.Client().Get(server.URL + "/api/aircraft/abc123/history")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !bytes.Contains(body, []byte(`"hex":"abc123"`)) {
		t.Fatalf("history status=%d body=%s", response.StatusCode, body)
	}
}

func TestIngestAuthenticationAndInvalidJSON(t *testing.T) {
	ctx := context.Background()
	db, err := database.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	token := strings.Repeat("b", 64)
	cfg, err := config.Load(map[string]string{
		"SKYTRACE_RECEIVER_TOKENS": `{"rx-1":"` + token + `"}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.SyncReceiverTokens(ctx, db.SQL, cfg.ReceiverTokens, time.Now()); err != nil {
		t.Fatal(err)
	}
	app, err := New(db.SQL, cfg, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(app)
	defer server.Close()

	request, _ := http.NewRequest(http.MethodPost, server.URL+"/api/ingest/readsb", strings.NewReader(`{}`))
	request.Header.Set("Content-Type", "application/json")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("missing token status = %d", response.StatusCode)
	}

	request, _ = http.NewRequest(http.MethodPost, server.URL+"/api/ingest/readsb", strings.NewReader(`{`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-Skytrace-Receiver", "rx-1")
	response, err = server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid JSON status = %d", response.StatusCode)
	}
}

func TestCoverageHTTPUsesCanonicalEncodingAndValidators(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "skytrace.db")
	db, err := database.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	cfg, err := config.Load(map[string]string{
		"SKYTRACE_DB_PATH": path,
	})
	if err != nil {
		t.Fatal(err)
	}
	cache, err := coverage.NewCache(path, coverage.OptionsFromConfig(cfg), 180)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	readyCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := cache.Ready(readyCtx); err != nil {
		t.Fatal(err)
	}
	app, err := New(db.SQL, cfg, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	app.SetCoverageCache(cache)

	identityRequest := httptest.NewRequest(http.MethodGet, "/api/coverage", nil)
	identityRequest.Header.Set("Accept-Encoding", "gzip;q=0")
	identity := httptest.NewRecorder()
	app.ServeHTTP(identity, identityRequest)
	if identity.Code != http.StatusOK {
		t.Fatalf("identity status=%d body=%s", identity.Code, identity.Body.String())
	}
	etag := identity.Header().Get("ETag")
	if etag == "" || identity.Header().Get("Content-Encoding") != "" ||
		identity.Header().Get("Cache-Control") != "public, max-age=0, must-revalidate" {
		t.Fatalf("identity headers = %#v", identity.Header())
	}

	notModifiedRequest := httptest.NewRequest(http.MethodGet, "/api/coverage", nil)
	notModifiedRequest.Header.Set("Accept-Encoding", "gzip;q=0")
	notModifiedRequest.Header.Set("If-None-Match", etag)
	notModified := httptest.NewRecorder()
	app.ServeHTTP(notModified, notModifiedRequest)
	if notModified.Code != http.StatusNotModified || notModified.Body.Len() != 0 {
		t.Fatalf("conditional response status=%d body=%q", notModified.Code, notModified.Body.String())
	}

	gzipRequest := httptest.NewRequest(http.MethodGet, "/api/coverage", nil)
	gzipRequest.Header.Set("Accept-Encoding", "gzip")
	gzipResponse := httptest.NewRecorder()
	app.ServeHTTP(gzipResponse, gzipRequest)
	if gzipResponse.Code != http.StatusOK ||
		gzipResponse.Header().Get("Content-Encoding") != "gzip" ||
		gzipResponse.Header().Get("ETag") == etag {
		t.Fatalf("gzip headers = %#v", gzipResponse.Header())
	}

	queryRequest := httptest.NewRequest(http.MethodGet, "/api/coverage?days=30", nil)
	queryResponse := httptest.NewRecorder()
	app.ServeHTTP(queryResponse, queryRequest)
	if queryResponse.Code != http.StatusBadRequest {
		t.Fatalf("query status=%d body=%s", queryResponse.Code, queryResponse.Body.String())
	}
}
