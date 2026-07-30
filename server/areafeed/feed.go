package areafeed

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/luftaquila/skytrace/server/ingest"
)

const (
	centreGrid             = 0.25
	centreSlackNM          = 20
	staleGrace             = time.Minute
	maxCachedAreas         = 64
	upstreamTimeout        = 10 * time.Second
	maxUpstreamWait        = 3 * time.Second
	maxUpstreamBodyBytes   = 8 * 1024 * 1024
	maxAreaAircraft        = 2000
	maxAreaCacheEntryBytes = 4 * 1024 * 1024
	maxAreaCacheBytes      = 64 * 1024 * 1024
)

var radiusSteps = []float64{50, 100, 150, 200, 250}

type Error struct {
	Status     int
	Message    string
	RetryAfter int
}

func (err *Error) Error() string {
	return err.Message
}

type AreaAircraft struct {
	ingest.Observation
	AreaFeed       bool     `json:"areaFeed"`
	ReceiverCount  int      `json:"receiverCount"`
	BestReceiverID *string  `json:"bestReceiverId"`
	Receivers      []string `json:"receivers"`
}

type Centre struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

type Response struct {
	Now            string         `json:"now"`
	Centre         Centre         `json:"centre"`
	RadiusNM       float64        `json:"radiusNm"`
	Count          int            `json:"count"`
	TruncatedCount int            `json:"truncatedCount"`
	Aircraft       []AreaAircraft `json:"aircraft"`
}

type cacheEntry struct {
	fetchedAt time.Time
	lastUsed  time.Time
	data      *Response
	bytes     int
	pending   *pending
}

type pending struct {
	done chan struct{}
	data *Response
	err  error
}

type Feed struct {
	enabled  bool
	template string
	origin   string
	host     string
	ttl      time.Duration
	gap      time.Duration
	client   *http.Client
	now      func() time.Time

	mu               sync.Mutex
	cache            map[string]*cacheEntry
	cachedBytes      int
	nextUpstreamSlot time.Time
	upstreamCalls    int
}

func New(template string, ttl, minGap time.Duration) (*Feed, error) {
	validated, err := validateTemplate(template)
	if err != nil {
		return nil, err
	}
	feed := &Feed{
		ttl:   ttl,
		gap:   minGap,
		cache: make(map[string]*cacheEntry),
		now:   time.Now,
		client: &http.Client{
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
	if validated != nil {
		feed.enabled = true
		feed.template = validated.template
		feed.origin = validated.origin
		feed.host = validated.host
	}
	return feed, nil
}

func (feed *Feed) Enabled() bool {
	return feed.enabled
}

func (feed *Feed) Host() *string {
	if !feed.enabled {
		return nil
	}
	value := feed.host
	return &value
}

func (feed *Feed) Query(ctx context.Context, lat, lon, radiusNM float64) (Response, error) {
	if !feed.enabled {
		return Response{}, &Error{Status: 404, Message: "area feed not configured"}
	}
	key, gridLat, gridLon, bucket := areaKey(lat, lon, math.Min(250, radiusNM))
	now := feed.now()
	feed.mu.Lock()
	previous := feed.cache[key]
	if previous != nil && previous.data != nil && now.Sub(previous.fetchedAt) < feed.ttl {
		previous.lastUsed = now
		result := *previous.data
		feed.mu.Unlock()
		return result, nil
	}
	if previous != nil && previous.pending != nil {
		wait := previous.pending
		feed.mu.Unlock()
		select {
		case <-ctx.Done():
			return Response{}, ctx.Err()
		case <-wait.done:
			if wait.err != nil {
				return Response{}, wait.err
			}
			return *wait.data, nil
		}
	}
	if err := feed.makeRoomLocked(); err != nil {
		feed.mu.Unlock()
		return Response{}, err
	}
	wait := &pending{done: make(chan struct{})}
	feed.cache[key] = &cacheEntry{
		lastUsed:  now,
		pending:   wait,
		data:      dataFromEntry(previous),
		fetchedAt: fetchedAt(previous),
		bytes:     bytesFromEntry(previous),
	}
	feed.mu.Unlock()

	data, err := feed.fetch(ctx, gridLat, gridLon, bucket)
	encodedBytes := 0
	if err == nil {
		encoded, encodeErr := json.Marshal(data)
		if encodeErr != nil {
			err = encodeErr
		} else if len(encoded) > maxAreaCacheEntryBytes {
			err = &Error{Status: 502, Message: "upstream response too large"}
		} else {
			encodedBytes = len(encoded)
		}
	}

	feed.mu.Lock()
	delete(feed.cache, key)
	if previous != nil {
		feed.cachedBytes -= previous.bytes
	}
	if err == nil {
		completedAt := feed.now()
		copyOfData := data
		feed.cache[key] = &cacheEntry{
			fetchedAt: completedAt,
			lastUsed:  completedAt,
			data:      &copyOfData,
			bytes:     encodedBytes,
		}
		feed.cachedBytes += encodedBytes
		feed.enforceBoundsLocked()
		wait.data = &copyOfData
	} else if previous != nil && previous.data != nil && now.Sub(previous.fetchedAt) < staleGrace {
		previous.lastUsed = now
		previous.pending = nil
		feed.cache[key] = previous
		feed.cachedBytes += previous.bytes
		wait.data = previous.data
		err = nil
	}
	wait.err = err
	close(wait.done)
	feed.mu.Unlock()
	if err != nil {
		return Response{}, err
	}
	return *wait.data, nil
}

func (feed *Feed) fetch(ctx context.Context, lat, lon, radius float64) (Response, error) {
	feed.mu.Lock()
	now := feed.now()
	wait := max(time.Duration(0), feed.nextUpstreamSlot.Sub(now))
	if wait > maxUpstreamWait {
		feed.mu.Unlock()
		return Response{}, &Error{Status: 503, Message: "area feed busy", RetryAfter: 3}
	}
	feed.nextUpstreamSlot = now.Add(wait + feed.gap)
	feed.mu.Unlock()
	if wait > 0 {
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return Response{}, ctx.Err()
		case <-timer.C:
		}
	}

	targetText := replaceSlots(
		feed.template,
		strconv.FormatFloat(lat, 'f', 3, 64),
		strconv.FormatFloat(lon, 'f', 3, 64),
		strconv.FormatFloat(radius, 'f', -1, 64),
	)
	target, err := url.Parse(targetText)
	if err != nil || origin(target) != feed.origin {
		return Response{}, &Error{Status: 502, Message: "upstream origin changed"}
	}
	requestCtx, cancel := context.WithTimeout(ctx, upstreamTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, target.String(), nil)
	if err != nil {
		return Response{}, &Error{Status: 502, Message: "upstream failed"}
	}
	response, err := feed.client.Do(request)
	if err != nil {
		return Response{}, &Error{Status: 502, Message: "upstream failed"}
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return Response{}, &Error{Status: 502, Message: "upstream redirect refused"}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Response{}, &Error{Status: 502, Message: "upstream failed"}
	}
	if response.ContentLength > maxUpstreamBodyBytes {
		return Response{}, &Error{Status: 502, Message: "upstream failed"}
	}
	reader := io.LimitReader(response.Body, maxUpstreamBodyBytes+1)
	bytes, err := io.ReadAll(reader)
	if err != nil || len(bytes) > maxUpstreamBodyBytes {
		return Response{}, &Error{Status: 502, Message: "upstream failed"}
	}
	decoder := json.NewDecoder(strings.NewReader(string(bytes)))
	decoder.UseNumber()
	var body map[string]any
	if err := decoder.Decode(&body); err != nil {
		return Response{}, &Error{Status: 502, Message: "upstream failed"}
	}
	feed.mu.Lock()
	feed.upstreamCalls++
	feed.mu.Unlock()

	list, _ := body["ac"].([]any)
	if list == nil {
		list, _ = body["aircraft"].([]any)
	}
	bounded := list
	if len(bounded) > maxAreaAircraft {
		bounded = bounded[:maxAreaAircraft]
	}
	now = feed.now()
	aircraft := make([]AreaAircraft, 0, len(bounded))
	for _, raw := range bounded {
		observation, _, ok := ingest.NormalizeAircraft(raw, now, 120)
		if !ok || observation.Lat == nil || observation.Lon == nil {
			continue
		}
		aircraft = append(aircraft, AreaAircraft{
			Observation:   observation,
			AreaFeed:      true,
			ReceiverCount: 0,
			Receivers:     []string{},
		})
	}
	return Response{
		Now:            iso(now),
		Centre:         Centre{Lat: lat, Lon: lon},
		RadiusNM:       radius,
		Count:          len(aircraft),
		TruncatedCount: max(0, len(list)-maxAreaAircraft),
		Aircraft:       aircraft,
	}, nil
}

func (feed *Feed) makeRoomLocked() error {
	for len(feed.cache) >= maxCachedAreas {
		key := feed.oldestCompletedLocked()
		if key == "" {
			return &Error{Status: 503, Message: "area feed busy", RetryAfter: 3}
		}
		feed.removeLocked(key)
	}
	return nil
}

func (feed *Feed) enforceBoundsLocked() {
	for len(feed.cache) > maxCachedAreas || feed.cachedBytes > maxAreaCacheBytes {
		key := feed.oldestCompletedLocked()
		if key == "" {
			return
		}
		feed.removeLocked(key)
	}
}

func (feed *Feed) oldestCompletedLocked() string {
	var oldestKey string
	var oldest time.Time
	for key, entry := range feed.cache {
		if entry.pending != nil {
			continue
		}
		if oldestKey == "" || entry.lastUsed.Before(oldest) {
			oldestKey = key
			oldest = entry.lastUsed
		}
	}
	return oldestKey
}

func (feed *Feed) removeLocked(key string) {
	if entry := feed.cache[key]; entry != nil {
		feed.cachedBytes -= entry.bytes
		delete(feed.cache, key)
	}
}

type validatedTemplate struct {
	template string
	origin   string
	host     string
}

func validateTemplate(raw string) (*validatedTemplate, error) {
	if raw == "" {
		return nil, nil
	}
	template := strings.TrimSpace(raw)
	if template == "" {
		return nil, configError("must not be blank")
	}
	for _, slot := range []string{"{lat}", "{lon}", "{radius}"} {
		if strings.Count(template, slot) != 1 {
			return nil, configError("must contain " + slot + " exactly once")
		}
	}
	remaining := template
	for _, slot := range []string{"{lat}", "{lon}", "{radius}"} {
		remaining = strings.ReplaceAll(remaining, slot, "")
	}
	if strings.ContainsAny(remaining, "{}") {
		return nil, configError("contains an unsupported placeholder")
	}
	parsed, err := url.Parse(template)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, configError("expected an absolute URL")
	}
	if parsed.User != nil {
		return nil, configError("credentials are not allowed")
	}
	if parsed.Fragment != "" {
		return nil, configError("fragments are not allowed")
	}
	authorityStart := strings.Index(template, "://") + 3
	resourceStart := len(template)
	for _, delimiter := range []string{"/", "?", "#"} {
		if index := strings.Index(template[authorityStart:], delimiter); index >= 0 && authorityStart+index < resourceStart {
			resourceStart = authorityStart + index
		}
	}
	resource := template[resourceStart:]
	if authorityStart < 3 ||
		!strings.Contains(resource, "{lat}") ||
		!strings.Contains(resource, "{lon}") ||
		!strings.Contains(resource, "{radius}") {
		return nil, configError("placeholders are allowed only in the path or query")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && loopback(parsed.Hostname())) {
		return nil, configError("HTTPS is required except for loopback HTTP")
	}
	expectedOrigin := origin(parsed)
	for _, values := range [][3]string{{"-12.345", "67.890", "123"}, {"45.678", "-89.012", "250"}} {
		replaced, err := url.Parse(replaceSlots(template, values[0], values[1], values[2]))
		if err != nil || origin(replaced) != expectedOrigin || replaced.User != nil {
			return nil, configError("placeholder substitution must not change the upstream origin")
		}
	}
	return &validatedTemplate{template: template, origin: expectedOrigin, host: parsed.Host}, nil
}

func replaceSlots(template, lat, lon, radius string) string {
	template = strings.ReplaceAll(template, "{lat}", lat)
	template = strings.ReplaceAll(template, "{lon}", lon)
	return strings.ReplaceAll(template, "{radius}", radius)
}

func origin(value *url.URL) string {
	return strings.ToLower(value.Scheme) + "://" + strings.ToLower(value.Host)
}

func loopback(host string) bool {
	host = strings.Trim(strings.ToLower(host), "[]")
	if host == "localhost" || host == "localhost." {
		return true
	}
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
}

func areaKey(lat, lon, radius float64) (string, float64, float64, float64) {
	gridLat := jsRound(lat/centreGrid) * centreGrid
	gridLon := jsRound(lon/centreGrid) * centreGrid
	bucket := float64(250)
	for _, step := range radiusSteps {
		if step >= radius+centreSlackNM {
			bucket = step
			break
		}
	}
	key := fmt.Sprintf("%.2f:%.2f:%v", gridLat, gridLon, bucket)
	return key, gridLat, gridLon, bucket
}

func jsRound(value float64) float64 {
	return math.Floor(value + 0.5)
}

func configError(detail string) error {
	return errors.New("invalid SKYTRACE_AREA_FEED_URL: " + detail)
}

func dataFromEntry(entry *cacheEntry) *Response {
	if entry == nil {
		return nil
	}
	return entry.data
}

func fetchedAt(entry *cacheEntry) time.Time {
	if entry == nil {
		return time.Time{}
	}
	return entry.fetchedAt
}

func bytesFromEntry(entry *cacheEntry) int {
	if entry == nil {
		return 0
	}
	return entry.bytes
}

func iso(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}
