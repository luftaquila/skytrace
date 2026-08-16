package coverage

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/luftaquila/skytrace/server/database"
	"github.com/luftaquila/skytrace/server/representation"
)

type CacheState struct {
	Ready               bool   `json:"ready"`
	Refreshing          bool   `json:"refreshing"`
	RequestedGeneration uint64 `json:"requestedGeneration"`
	CompletedGeneration uint64 `json:"completedGeneration"`
	LastErrorAt         string `json:"lastErrorAt,omitempty"`
	LastDurationMS      int64  `json:"lastDurationMs,omitempty"`
}

type Cache struct {
	db       *database.DB
	options  Options
	interval time.Duration

	mu                  sync.RWMutex
	representation      representation.Encoded
	contentIdentity     string
	requestedGeneration uint64
	completedGeneration uint64
	refreshing          bool
	closed              bool
	lastErrorAt         string
	lastDurationMS      int64

	requests chan buildRequest
	stop     chan struct{}
	done     chan struct{}
}

type buildRequest struct {
	generation uint64
	waiter     chan error
}

func NewCache(dbPath string, options Options, refreshSeconds int) (*Cache, error) {
	if refreshSeconds <= 0 {
		refreshSeconds = 180
	}
	db, err := database.Open(context.Background(), dbPath)
	if err != nil {
		return nil, err
	}
	cache := &Cache{
		db:       db,
		options:  NormalizeOptions(options),
		interval: maxDuration(time.Second, time.Duration(refreshSeconds)*time.Second),
		requests: make(chan buildRequest, 1),
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}
	go cache.run()
	cache.request(nil)
	return cache, nil
}

func (cache *Cache) run() {
	defer close(cache.done)
	defer cache.db.Close()
	ticker := time.NewTicker(cache.interval)
	defer ticker.Stop()
	receiverCache := make(ReceiverCache)
	for {
		select {
		case request := <-cache.requests:
			err := cache.build(receiverCache, request.generation)
			if request.waiter != nil {
				request.waiter <- err
				close(request.waiter)
			}
		case <-ticker.C:
			cache.request(nil)
		case <-cache.stop:
			for {
				select {
				case request := <-cache.requests:
					if request.waiter != nil {
						request.waiter <- errors.New("coverage cache is closed")
						close(request.waiter)
					}
				default:
					return
				}
			}
		}
	}
}

func (cache *Cache) request(waiter chan error) bool {
	cache.mu.Lock()
	if cache.closed {
		cache.mu.Unlock()
		if waiter != nil {
			waiter <- errors.New("coverage cache is closed")
			close(waiter)
		}
		return false
	}
	cache.requestedGeneration++
	generation := cache.requestedGeneration
	cache.mu.Unlock()
	request := buildRequest{generation: generation, waiter: waiter}
	if waiter == nil {
		select {
		case cache.requests <- request:
			return true
		default:
			return false
		}
	}
	select {
	case cache.requests <- request:
		return true
	case <-cache.stop:
		if waiter != nil {
			waiter <- errors.New("coverage cache is closed")
			close(waiter)
		}
		return false
	}
}

func (cache *Cache) build(receiverCache ReceiverCache, targetGeneration uint64) error {
	cache.mu.Lock()
	cache.refreshing = true
	cache.mu.Unlock()
	started := time.Now()
	snapshot, _, err := Refresh(context.Background(), cache.db.SQL, cache.options, started, receiverCache)
	completed := time.Now()
	// A refresh that outruns its own interval is a rebuild walking the whole
	// retention window; that is the shape of an incident, so say so in the log.
	if elapsed := completed.Sub(started); elapsed > cache.interval {
		log.Printf("coverage refresh took %s (interval %s)", elapsed.Truncate(time.Millisecond), cache.interval)
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	defer func() {
		cache.refreshing = false
		cache.completedGeneration = targetGeneration
		cache.lastDurationMS = maxInt64(0, completed.Sub(started).Milliseconds())
	}()
	if err != nil {
		cache.lastErrorAt = database.ISOTime(completed)
		if len(cache.representation.Identity) != 0 {
			log.Printf("coverage refresh failed: %v", err)
			return nil
		}
		return err
	}
	stable, err := stableSnapshot(snapshot, int(cache.interval/time.Second))
	if err != nil {
		cache.lastErrorAt = database.ISOTime(completed)
		return err
	}
	stableBytes, err := json.Marshal(stable)
	if err != nil {
		cache.lastErrorAt = database.ISOTime(completed)
		return err
	}
	nextIdentity := representation.StrongETag(stableBytes)
	if nextIdentity != cache.contentIdentity {
		stable["contentGeneratedAt"] = database.ISOTime(completed)
		encoded, encodeErr := representation.EncodeJSON(stable, 1, 0)
		if encodeErr != nil {
			cache.lastErrorAt = database.ISOTime(completed)
			return encodeErr
		}
		cache.representation = encoded
		cache.contentIdentity = nextIdentity
	}
	cache.lastErrorAt = ""
	return nil
}

func stableSnapshot(snapshot Snapshot, refreshSeconds int) (map[string]any, error) {
	bytes, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	var value map[string]any
	if err := json.Unmarshal(bytes, &value); err != nil {
		return nil, err
	}
	delete(value, "from")
	delete(value, "to")
	delete(value, "generatedAt")
	delete(value, "nextRefreshAt")
	value["refreshIntervalSeconds"] = refreshSeconds
	areas, _ := value["areas"].([]any)
	for _, rawArea := range areas {
		area, _ := rawArea.(map[string]any)
		mesh, _ := area["volumeMesh"].(map[string]any)
		stats, _ := mesh["stats"].(map[string]any)
		delete(stats, "generatedMs")
	}
	return value, nil
}

func (cache *Cache) Representation() (representation.Encoded, bool) {
	cache.mu.RLock()
	defer cache.mu.RUnlock()
	if len(cache.representation.Identity) == 0 {
		return representation.Encoded{}, false
	}
	return cache.representation, true
}

func (cache *Cache) Refresh(ctx context.Context) error {
	waiter := make(chan error, 1)
	if !cache.request(waiter) {
		return errors.New("coverage cache is closed")
	}
	select {
	case err := <-waiter:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (cache *Cache) Ready(ctx context.Context) error {
	if _, ok := cache.Representation(); ok {
		return nil
	}
	return cache.Refresh(ctx)
}

func (cache *Cache) State() CacheState {
	cache.mu.RLock()
	defer cache.mu.RUnlock()
	return CacheState{
		Ready:               len(cache.representation.Identity) != 0,
		Refreshing:          cache.refreshing,
		RequestedGeneration: cache.requestedGeneration,
		CompletedGeneration: cache.completedGeneration,
		LastErrorAt:         cache.lastErrorAt,
		LastDurationMS:      cache.lastDurationMS,
	}
}

func (cache *Cache) Close() error {
	cache.mu.Lock()
	if cache.closed {
		cache.mu.Unlock()
		<-cache.done
		return nil
	}
	cache.closed = true
	close(cache.stop)
	cache.mu.Unlock()
	<-cache.done
	return nil
}

func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
