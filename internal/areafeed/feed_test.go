package areafeed

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestTemplateValidation(t *testing.T) {
	if _, err := New("http://example.com/v2/{lat}/{lon}/{radius}", time.Second, time.Second); err == nil ||
		!strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("error = %v", err)
	}
	if _, err := New("https://{lat}.example.com/{lon}/{radius}", time.Second, time.Second); err == nil {
		t.Fatalf("error = %v", err)
	}
	feed, err := New("", time.Second, time.Second)
	if err != nil || feed.Enabled() {
		t.Fatalf("feed=%#v err=%v", feed, err)
	}
}

func TestQueryNormalizesAndCaches(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		response.Header().Set("Content-Type", "application/json")
		fmt.Fprint(response, `{"ac":[{
			"hex":"abc123","seen":0,"seen_pos":0,"lat":37.5,"lon":127.1,"type":"adsb_icao"
		}]}`)
	}))
	defer server.Close()
	feed, err := New(server.URL+"/v2/{lat}/{lon}/{radius}", 5*time.Second, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	first, err := feed.Query(context.Background(), 37.51, 127.11, 20)
	if err != nil {
		t.Fatal(err)
	}
	second, err := feed.Query(context.Background(), 37.52, 127.12, 20)
	if err != nil {
		t.Fatal(err)
	}
	if first.Count != 1 || !first.Aircraft[0].AreaFeed || second.Count != 1 {
		t.Fatalf("responses = %#v %#v", first, second)
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d", calls.Load())
	}
}

func TestAircraftEnvelopeCacheExpiryAndHost(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		response.Header().Set("Content-Type", "application/json")
		fmt.Fprint(response, `{"aircraft":[{
			"hex":"abc123","seen":0,"seen_pos":0,"lat":37.5,"lon":127.1,"type":"adsb_icao"
		}]}`)
	}))
	defer server.Close()
	feed, err := New(server.URL+"/v2/{lat}/{lon}/{radius}", 5*time.Second, 0)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 30, 0, 0, 0, 0, time.UTC)
	feed.now = func() time.Time { return now }
	host := feed.Host()
	if host == nil || *host != strings.TrimPrefix(server.URL, "http://") {
		t.Fatalf("host = %v", host)
	}
	first, err := feed.Query(context.Background(), 37.5, 127.1, 20)
	if err != nil || first.Count != 1 || !first.Aircraft[0].AreaFeed {
		t.Fatalf("first=%#v err=%v", first, err)
	}
	now = now.Add(4 * time.Second)
	if _, err := feed.Query(context.Background(), 37.5, 127.1, 20); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Second)
	if _, err := feed.Query(context.Background(), 37.5, 127.1, 20); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("upstream calls = %d, want 2", calls.Load())
	}
}

func TestRedirectsAndTemplateOriginChangesAreRefused(t *testing.T) {
	redirect := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		http.Redirect(response, request, "/other", http.StatusFound)
	}))
	defer redirect.Close()
	feed, err := New(redirect.URL+"/v2/{lat}/{lon}/{radius}", time.Second, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, err = feed.Query(context.Background(), 37.5, 127.1, 20)
	var feedError *Error
	if !errors.As(err, &feedError) || feedError.Status != http.StatusBadGateway {
		t.Fatalf("redirect error = %v", err)
	}

	for _, template := range []string{
		"https://user:pass@example.com/{lat}/{lon}/{radius}",
		"https://{lat}.example.com/{lon}/{radius}",
		"https://example.com/{lat}/{lon}/{radius}#fragment",
		"https://example.com/{lat}/{lon}/{radius}/{other}",
	} {
		if _, err := New(template, time.Second, 0); err == nil {
			t.Errorf("template %q unexpectedly succeeded", template)
		}
	}
}
