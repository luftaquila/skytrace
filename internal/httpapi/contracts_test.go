package httpapi

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/luftaquila/skytrace/internal/config"
	"github.com/luftaquila/skytrace/internal/database"
)

func TestStaticRepresentationsAndMissingNotices(t *testing.T) {
	staticDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(staticDir, "assets"), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"index.html":                  "<!doctype html><title>Skytrace</title>",
		"assets/app.js":               "console.log('identity')",
		"assets/app.js.gz":            "compressed-asset",
		"third-party-notices.json":    `{"packages":[]}`,
		"third-party-notices.json.gz": "compressed-notices",
	} {
		if err := os.WriteFile(filepath.Join(staticDir, filepath.FromSlash(name)), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	app, closeApp := contractApp(t, map[string]string{"SKYTRACE_STATIC_DIR": staticDir})
	defer closeApp()

	assetRequest := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	assetRequest.Header.Set("Accept-Encoding", "gzip")
	asset := httptest.NewRecorder()
	app.ServeHTTP(asset, assetRequest)
	if asset.Code != http.StatusOK ||
		asset.Header().Get("Content-Encoding") != "gzip" ||
		asset.Header().Get("Vary") != "Accept-Encoding" ||
		asset.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" ||
		asset.Body.String() != "compressed-asset" {
		t.Fatalf("asset = %d %#v %q", asset.Code, asset.Header(), asset.Body.String())
	}
	conditionalRequest := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	conditionalRequest.Header.Set("Accept-Encoding", "gzip")
	conditionalRequest.Header.Set("If-None-Match", asset.Header().Get("ETag"))
	conditional := httptest.NewRecorder()
	app.ServeHTTP(conditional, conditionalRequest)
	if conditional.Code != http.StatusNotModified || conditional.Body.Len() != 0 {
		t.Fatalf("conditional = %d %q", conditional.Code, conditional.Body.String())
	}

	noticesRequest := httptest.NewRequest(http.MethodGet, "/third-party-notices.json", nil)
	noticesRequest.Header.Set("Accept-Encoding", "gzip")
	notices := httptest.NewRecorder()
	app.ServeHTTP(notices, noticesRequest)
	if notices.Code != http.StatusOK ||
		notices.Header().Get("Cache-Control") != "public, max-age=0, must-revalidate" ||
		notices.Body.String() != "compressed-notices" {
		t.Fatalf("notices = %d %#v %q", notices.Code, notices.Header(), notices.Body.String())
	}

	if err := os.Remove(filepath.Join(staticDir, "third-party-notices.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(staticDir, "third-party-notices.json.gz")); err != nil {
		t.Fatal(err)
	}
	missing := httptest.NewRecorder()
	app.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/third-party-notices.json", nil))
	if missing.Code != http.StatusNotFound ||
		!strings.Contains(missing.Body.String(), `"error":"not found"`) ||
		strings.Contains(missing.Body.String(), "<!doctype html>") {
		t.Fatalf("missing notices = %d %q", missing.Code, missing.Body.String())
	}
}

func TestHTTPValidationAndNoForwardedTLSInference(t *testing.T) {
	app, closeApp := contractApp(t, nil)
	defer closeApp()

	healthRequest := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	healthRequest.Header.Set("X-Forwarded-Proto", "http")
	health := httptest.NewRecorder()
	app.ServeHTTP(health, healthRequest)
	if health.Code != http.StatusOK || health.Header().Get("Strict-Transport-Security") != "" {
		t.Fatalf("health = %d %#v", health.Code, health.Header())
	}

	disabledArea := httptest.NewRecorder()
	app.ServeHTTP(disabledArea, httptest.NewRequest(
		http.MethodGet,
		"/api/area-traffic?lat=37.5&lon=127.1&radius=20",
		nil,
	))
	if disabledArea.Code != http.StatusNotFound {
		t.Fatalf("disabled area status = %d", disabledArea.Code)
	}

	enabled, closeEnabled := contractApp(t, map[string]string{
		"SKYTRACE_AREA_FEED_URL": "http://127.0.0.1:1/v2/{lat}/{lon}/{radius}",
	})
	defer closeEnabled()
	invalidArea := httptest.NewRecorder()
	enabled.ServeHTTP(invalidArea, httptest.NewRequest(
		http.MethodGet,
		"/api/area-traffic?lat=91&lon=127.1&radius=20",
		nil,
	))
	if invalidArea.Code != http.StatusBadRequest {
		t.Fatalf("invalid area status = %d body=%q", invalidArea.Code, invalidArea.Body.String())
	}

	oversizedBody := `{"aircraft":[],"padding":"` + strings.Repeat("x", 70*1024) + `"}`
	oversizedRequest := httptest.NewRequest(
		http.MethodPost,
		"/api/aircraft/tracks",
		strings.NewReader(oversizedBody),
	)
	oversizedRequest.Header.Set("Content-Type", "application/json")
	oversized := httptest.NewRecorder()
	app.ServeHTTP(oversized, oversizedRequest)
	if oversized.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized status = %d body=%q", oversized.Code, oversized.Body.String())
	}
}

func TestHealthRejectsMissingSchema(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	cfg, err := config.Load(map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	app, err := New(db, cfg, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	app.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("health status = %d body=%q", response.Code, response.Body.String())
	}
}

func contractApp(t *testing.T, env map[string]string) (*App, func()) {
	t.Helper()
	db, err := database.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(env)
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	app, err := New(db.SQL, cfg, nil, nil)
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	return app, func() {
		app.hub.Close()
		if err := db.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	}
}
