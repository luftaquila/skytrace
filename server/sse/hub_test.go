package sse

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHubEnforcesPerIPLimitAndDrainsOnClose(t *testing.T) {
	hub := New()
	type runningClient struct {
		cancel context.CancelFunc
		done   chan struct{}
	}
	clients := make([]runningClient, 0, 6)
	for range 6 {
		ctx, cancel := context.WithCancel(context.Background())
		request := httptest.NewRequest(http.MethodGet, "/api/events", nil).WithContext(ctx)
		recorder := httptest.NewRecorder()
		done := make(chan struct{})
		go func() {
			defer close(done)
			hub.Serve(recorder, request, "192.0.2.1")
		}()
		clients = append(clients, runningClient{cancel: cancel, done: done})
	}
	waitForSize(t, hub, 6)

	rejected := httptest.NewRecorder()
	hub.Serve(
		rejected,
		httptest.NewRequest(http.MethodGet, "/api/events", nil),
		"192.0.2.1",
	)
	if rejected.Code != http.StatusServiceUnavailable ||
		rejected.Header().Get("Retry-After") != "30" ||
		!strings.Contains(rejected.Body.String(), "event stream limit reached") {
		t.Fatalf("rejected response = %d %#v %q", rejected.Code, rejected.Header(), rejected.Body.String())
	}

	hub.Close()
	hub.Close()
	for _, client := range clients {
		client.cancel()
		select {
		case <-client.done:
		case <-time.After(time.Second):
			t.Fatal("SSE client did not drain")
		}
	}
	waitForSize(t, hub, 0)

	closed := httptest.NewRecorder()
	hub.Serve(closed, httptest.NewRequest(http.MethodGet, "/api/events", nil), "192.0.2.2")
	if closed.Code != http.StatusServiceUnavailable ||
		!strings.Contains(closed.Body.String(), "event stream unavailable") {
		t.Fatalf("closed response = %d %q", closed.Code, closed.Body.String())
	}
}

func TestWriteEventPreservesEventAndJSONData(t *testing.T) {
	recorder := httptest.NewRecorder()
	if !writeEvent(recorder, recorder, event{name: "ingest", data: []byte(`{"ok":true}`)}) {
		t.Fatal("writeEvent failed")
	}
	if recorder.Body.String() != "event: ingest\ndata: {\"ok\":true}\n\n" {
		t.Fatalf("event = %q", recorder.Body.String())
	}
}

func waitForSize(t *testing.T, hub *Hub, size int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if hub.Size() == size {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("hub size = %d, want %d", hub.Size(), size)
}
