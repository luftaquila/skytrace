package sse

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

type event struct {
	name string
	data []byte
}

type client struct {
	ip     string
	events chan event
	done   chan struct{}
}

type Hub struct {
	mu      sync.Mutex
	clients map[*client]struct{}
	byIP    map[string]int
	closed  bool
}

func New() *Hub {
	return &Hub{
		clients: make(map[*client]struct{}),
		byIP:    make(map[string]int),
	}
}

func (hub *Hub) Serve(response http.ResponseWriter, request *http.Request, ip string) {
	flusher, ok := response.(http.Flusher)
	if !ok {
		writeError(response, "event stream unavailable")
		return
	}
	current := &client{
		ip:     ip,
		events: make(chan event, 8),
		done:   make(chan struct{}),
	}
	hub.mu.Lock()
	if hub.closed {
		hub.mu.Unlock()
		writeError(response, "event stream unavailable")
		return
	}
	if len(hub.clients) >= 200 || hub.byIP[ip] >= 6 {
		hub.mu.Unlock()
		writeError(response, "event stream limit reached")
		return
	}
	hub.clients[current] = struct{}{}
	hub.byIP[ip]++
	hub.mu.Unlock()
	defer hub.remove(current)

	response.Header().Set("Content-Type", "text/event-stream")
	response.Header().Set("Cache-Control", "no-cache, no-transform")
	response.Header().Set("Connection", "keep-alive")
	response.Header().Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)
	if !writeEvent(response, flusher, event{name: "hello", data: mustJSON(map[string]any{"now": iso(time.Now())})}) {
		return
	}

	timer := time.NewTicker(25 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case <-current.done:
			return
		case message := <-current.events:
			if !writeEvent(response, flusher, message) {
				return
			}
		case <-timer.C:
			if !writeEvent(response, flusher, event{name: "ping", data: mustJSON(map[string]any{"now": iso(time.Now())})}) {
				return
			}
		}
	}
}

func (hub *Hub) Broadcast(name string, value any) {
	message := event{name: name, data: mustJSON(value)}
	hub.mu.Lock()
	defer hub.mu.Unlock()
	for current := range hub.clients {
		select {
		case current.events <- message:
		default:
			close(current.done)
			delete(hub.clients, current)
			hub.byIP[current.ip]--
		}
	}
}

func (hub *Hub) Size() int {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	return len(hub.clients)
}

func (hub *Hub) Close() {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.closed {
		return
	}
	hub.closed = true
	for current := range hub.clients {
		close(current.done)
	}
}

func (hub *Hub) remove(current *client) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if _, exists := hub.clients[current]; !exists {
		return
	}
	delete(hub.clients, current)
	hub.byIP[current.ip]--
	if hub.byIP[current.ip] <= 0 {
		delete(hub.byIP, current.ip)
	}
}

func writeEvent(response http.ResponseWriter, flusher http.Flusher, message event) bool {
	controller := http.NewResponseController(response)
	_ = controller.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if _, err := fmt.Fprintf(response, "event: %s\ndata: %s\n\n", message.name, message.data); err != nil {
		return false
	}
	flusher.Flush()
	_ = controller.SetWriteDeadline(time.Time{})
	return true
}

func writeError(response http.ResponseWriter, message string) {
	response.Header().Set("Retry-After", "30")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(http.StatusServiceUnavailable)
	_, _ = fmt.Fprintf(response, `{"ok":false,"error":%q}`, message)
}

func mustJSON(value any) []byte {
	bytes, err := json.Marshal(value)
	if err != nil {
		return []byte("null")
	}
	return bytes
}

func iso(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}
