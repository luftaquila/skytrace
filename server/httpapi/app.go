package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/luftaquila/skytrace/server/airfields"
	"github.com/luftaquila/skytrace/server/areafeed"
	"github.com/luftaquila/skytrace/server/config"
	"github.com/luftaquila/skytrace/server/coverage"
	"github.com/luftaquila/skytrace/server/ingest"
	"github.com/luftaquila/skytrace/server/limits"
	"github.com/luftaquila/skytrace/server/representation"
	"github.com/luftaquila/skytrace/server/sse"
	"github.com/luftaquila/skytrace/server/tracks"
)

var bearerPattern = regexp.MustCompile(`(?i)^Bearer\s+(.+)$`)

// Well under the receiver's 15s upload deadline, so a stall is logged while the
// receiver is still waiting rather than only after it has already given up.
const slowIngestThreshold = 2 * time.Second

type App struct {
	db        *sql.DB
	config    config.Config
	hub       *sse.Hub
	handler   http.Handler
	areaFeed  *areafeed.Feed
	airfields *airfields.Store
	coverage  *coverage.Cache

	authIP        *limits.Pool
	authGlobal    *limits.Pool
	ingestRequest *limits.Pool
	observation   *limits.Pool
	track         *limits.Pool
	routeLimits   map[string]*routeLimit

	liveMu    sync.Mutex
	liveAt    time.Time
	liveCache representation.Encoded

	mlatRefs mlatReferenceCache
}

type routeLimit struct {
	mu            sync.Mutex
	ip            *limits.Pool
	global        *limits.Pool
	inFlightLimit int
	perIPLimit    int
	inFlight      int
	inFlightByIP  map[string]int
}

type liveFeatures struct {
	AreaFeed     bool    `json:"areaFeed"`
	AreaFeedHost *string `json:"areaFeedHost"`
}

type liveResponse struct {
	Now            string                  `json:"now"`
	Count          int                     `json:"count"`
	Summary        tracks.Summary          `json:"summary"`
	Aircraft       []tracks.Aircraft       `json:"aircraft"`
	Receivers      []tracks.PublicReceiver `json:"receivers"`
	Features       liveFeatures            `json:"features"`
	TruncatedCount int                     `json:"truncatedCount"`
}

func New(db *sql.DB, cfg config.Config, hub *sse.Hub, airfieldStore *airfields.Store) (*App, error) {
	if hub == nil {
		hub = sse.New()
	}
	areaFeed, err := areafeed.New(
		cfg.AreaFeedURL,
		time.Duration(cfg.AreaFeedTTLSeconds)*time.Second,
		time.Duration(cfg.AreaFeedMinUpstreamMS)*time.Millisecond,
	)
	if err != nil {
		return nil, err
	}
	app := &App{
		db:            db,
		config:        cfg,
		hub:           hub,
		areaFeed:      areaFeed,
		airfields:     airfieldStore,
		authIP:        limits.NewPool(120, 20, 10000),
		authGlobal:    limits.NewPool(600, 60, 1),
		ingestRequest: limits.NewPool(60, 10, 10000),
		observation:   limits.NewPool(10000, 2000, 10000),
		track:         limits.NewPool(2000, 1000, 10000),
		routeLimits: map[string]*routeLimit{
			"bulk":     newRouteLimit(120, 20, 480, 80, 8, 0),
			"history":  newRouteLimit(30, 10, 240, 40, 16, 0),
			"area":     newRouteLimit(30, 10, 60, 10, 0, 0),
			"coverage": newRouteLimit(30, 5, 120, 20, 0, 0),
			"live":     newRouteLimit(120, 20, 600, 60, 32, 4),
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", app.health)
	mux.HandleFunc("GET /api/events", app.events)
	mux.HandleFunc("POST /api/ingest/readsb", app.ingest)
	mux.Handle("POST /api/aircraft/tracks", app.withRouteLimit("bulk", http.HandlerFunc(app.bulkTracks)))
	mux.Handle("GET /api/live", app.withRouteLimit("live", http.HandlerFunc(app.live)))
	mux.Handle("GET /api/coverage", app.withRouteLimit("coverage", http.HandlerFunc(app.coverageResponse)))
	mux.Handle("GET /api/aircraft/search", app.withRouteLimit("history", http.HandlerFunc(app.aircraftSearch)))
	mux.Handle("GET /api/aircraft/{hex}/history", app.withRouteLimit("history", http.HandlerFunc(app.history)))
	mux.Handle("GET /api/aircraft/{hex}/history.kml", app.withRouteLimit("history", http.HandlerFunc(app.historyKML)))
	mux.Handle("GET /api/area-traffic", app.withRouteLimit("area", http.HandlerFunc(app.areaTraffic)))
	if app.airfields != nil {
		mux.HandleFunc("GET /api/airfields/manifest", app.airfieldManifest)
		mux.HandleFunc("GET /api/airfields/{version}/{file}", app.airfieldPayload)
	}
	app.registerStatic(mux)
	mux.HandleFunc("/", app.fallback)
	app.handler = securityHeaders(mux)
	return app, nil
}

func (app *App) SetCoverageCache(cache *coverage.Cache) {
	app.coverage = cache
}

func (app *App) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	app.handler.ServeHTTP(response, request)
}

func (app *App) health(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	var ok int
	if err := app.db.QueryRowContext(request.Context(), "SELECT COUNT(*) >= 0 FROM receivers").Scan(&ok); err != nil || ok != 1 {
		representation.WriteJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false})
		return
	}
	representation.WriteJSON(response, http.StatusOK, map[string]any{"ok": true})
}

func (app *App) events(response http.ResponseWriter, request *http.Request) {
	app.hub.Serve(response, request, app.clientIP(request))
}

func (app *App) ingest(response http.ResponseWriter, request *http.Request) {
	ip := app.clientIP(request)
	ipLimit := app.authIP.Consume(ip, 1)
	globalLimit := app.authGlobal.Consume("global", 1)
	if !ipLimit.OK || !globalLimit.OK {
		if !ipLimit.OK {
			rejectLimited(response, http.StatusTooManyRequests, ipLimit.RetryAfter)
		} else {
			rejectLimited(response, http.StatusServiceUnavailable, globalLimit.RetryAfter)
		}
		return
	}

	headerRaw, headerPresent := request.Header["X-Skytrace-Receiver"]
	headerReceiverID := ""
	if headerPresent && len(headerRaw) != 0 {
		headerReceiverID, _ = ingest.SanitizeReceiverID(headerRaw[0])
	}
	authStarted := time.Now()
	auth, err := ingest.Authenticate(
		request.Context(),
		app.db,
		bearerToken(request.Header.Get("Authorization")),
		headerReceiverID,
	)
	authElapsed := time.Since(authStarted)
	if err != nil {
		internalError(response)
		return
	}
	if !auth.OK {
		response.Header().Set("Cache-Control", "no-store")
		representation.WriteJSON(response, http.StatusUnauthorized, map[string]any{
			"ok": false, "error": auth.Reason,
		})
		return
	}
	requestLimit := app.ingestRequest.Consume(auth.ReceiverID, 1)
	if !requestLimit.OK {
		rejectLimited(response, http.StatusTooManyRequests, requestLimit.RetryAfter)
		return
	}

	body, status, message := decodeJSON(request, response, 8*1024*1024)
	if status != 0 {
		representation.WriteJSON(response, status, map[string]any{"ok": false, "error": message})
		return
	}
	payload, _ := body.(map[string]any)
	if payload == nil {
		payload = map[string]any{}
	}
	receiver, _ := payload["receiver"].(map[string]any)
	bodyReceiverID := ""
	bodyReceiverPresent := false
	if receiver != nil {
		if raw, exists := receiver["id"]; exists && raw != nil {
			bodyReceiverPresent = true
			text, isString := raw.(string)
			if isString {
				bodyReceiverID, _ = ingest.SanitizeReceiverID(text)
			}
		}
	}
	if (bodyReceiverPresent && bodyReceiverID == "") ||
		(headerPresent && headerReceiverID == "") ||
		(bodyReceiverID != "" && bodyReceiverID != auth.ReceiverID) ||
		(headerReceiverID != "" && headerReceiverID != auth.ReceiverID) {
		response.Header().Set("Cache-Control", "no-store")
		representation.WriteJSON(response, http.StatusUnauthorized, map[string]any{
			"ok": false, "error": "invalid token",
		})
		return
	}

	rawCount := rawAircraftCount(payload)
	observationLimit := app.observation.Consume(auth.ReceiverID, float64(rawCount))
	if !observationLimit.OK {
		rejectLimited(response, http.StatusTooManyRequests, observationLimit.RetryAfter)
		return
	}
	storeStarted := time.Now()
	result, err := ingest.Store(request.Context(), app.db, payload, ingest.Options{
		ReceiverID:               auth.ReceiverID,
		TokenHash:                auth.TokenHash,
		ReceivedAt:               time.Now(),
		RemoteAddr:               ip,
		UserAgent:                request.UserAgent(),
		MaxObservationAgeSeconds: float64(app.config.MaxObservationAgeSeconds),
		TrackMinIntervalSeconds:  float64(app.config.TrackMinIntervalSeconds),
		PositionFilterMaxMach:    app.config.PositionFilterMaxMach,
		MlatReference:            app.mlatReference(request.Context(), auth.ReceiverID),
		ConsumeTrackBudget: func(receiverID string) bool {
			return app.track.Consume(receiverID, 1).OK
		},
	})
	// Receivers give up on an upload after 15s and only report "timeout", which says
	// nothing about which phase stalled. Naming the phase here is what tells a stall
	// on the shared connection apart from one waiting on the write lock.
	if storeElapsed := time.Since(storeStarted); storeElapsed > slowIngestThreshold {
		log.Printf(
			"slow ingest: receiver=%s auth=%s store=%s aircraft=%d",
			auth.ReceiverID,
			authElapsed.Truncate(time.Millisecond),
			storeElapsed.Truncate(time.Millisecond),
			rawCount,
		)
	}
	if err != nil {
		internalError(response)
		return
	}
	changed := result.ChangedHexes
	if len(changed) > 200 {
		changed = changed[:200]
	}
	app.hub.Broadcast("ingest", map[string]any{
		"receiverId":    result.ReceiverID,
		"receivedAt":    result.ReceivedAt,
		"acceptedCount": result.AcceptedCount,
		"trackPoints":   result.TrackPoints,
		"changedHexes":  changed,
	})
	representation.WriteJSON(response, http.StatusOK, struct {
		OK bool `json:"ok"`
		ingest.Result
		SSEClients int `json:"sseClients"`
	}{OK: true, Result: result, SSEClients: app.hub.Size()})
}

func (app *App) bulkTracks(response http.ResponseWriter, request *http.Request) {
	body, status, message := decodeJSON(request, response, 64*1024)
	if status != 0 {
		representation.WriteJSON(response, status, map[string]any{"ok": false, "error": message})
		return
	}
	normalized, ok := tracks.NormalizeBulkRequest(body)
	if !ok {
		representation.WriteJSON(response, http.StatusBadRequest, map[string]any{
			"ok": false, "error": "invalid bulk track request",
		})
		return
	}
	result, err := tracks.BulkTracks(request.Context(), app.db, normalized, time.Now(), 24)
	if err != nil {
		internalError(response)
		return
	}
	encoded, err := representation.EncodeJSON(result, 1024, 0)
	if err != nil {
		internalError(response)
		return
	}
	representation.Send(response, request, encoded, "")
}

func (app *App) live(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithTimeout(request.Context(), 10*time.Second)
	defer cancel()
	encoded, err := app.liveRepresentation(ctx, time.Now())
	if err != nil {
		internalError(response)
		return
	}
	representation.Send(response, request, encoded, "")
}

func (app *App) liveRepresentation(ctx context.Context, now time.Time) (representation.Encoded, error) {
	app.liveMu.Lock()
	defer app.liveMu.Unlock()
	if !app.liveAt.IsZero() && now.Sub(app.liveAt) < time.Second {
		return app.liveCache, nil
	}
	current, err := tracks.CurrentAircraft(
		ctx,
		app.db,
		now,
		time.Duration(app.config.CurrentWindowSeconds)*time.Second,
	)
	if err != nil {
		return representation.Encoded{}, err
	}
	receivers, err := tracks.PublicReceivers(
		ctx,
		app.db,
		now,
		time.Duration(app.config.CurrentWindowSeconds)*time.Second,
	)
	if err != nil {
		return representation.Encoded{}, err
	}
	maxAircraft := app.config.LiveMaxAircraft
	if maxAircraft < 0 {
		maxAircraft = 0
	}
	aircraft := current.Aircraft
	if len(aircraft) > maxAircraft {
		aircraft = aircraft[:maxAircraft]
	}
	for {
		value := liveResponse{
			Now:       current.Now,
			Count:     len(aircraft),
			Summary:   summarize(aircraft),
			Aircraft:  aircraft,
			Receivers: receivers,
			Features: liveFeatures{
				AreaFeed:     app.areaFeed.Enabled(),
				AreaFeedHost: app.areaFeed.Host(),
			},
			TruncatedCount: max(0, len(current.Aircraft)-len(aircraft)),
		}
		encoded, err := representation.EncodeJSON(value, 1024, app.config.LiveMaxBytes)
		if err == nil {
			app.liveAt = now
			app.liveCache = encoded
			return encoded, nil
		}
		if !errors.Is(err, representation.ErrTooLarge) || len(aircraft) == 0 {
			return representation.Encoded{}, err
		}
		aircraft = aircraft[:len(aircraft)/2]
	}
}

// aircraftSearch finds archived aircraft by callsign or hex prefix, so the operator
// can pull up flights that have already left the live picture. Shares the history
// route limit: both are operator-paced archive reads.
func (app *App) aircraftSearch(response http.ResponseWriter, request *http.Request) {
	results, err := tracks.SearchAircraft(request.Context(), app.db, request.URL.Query().Get("q"), time.Now())
	if err != nil {
		writeQueryError(response, err)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	encoded, err := representation.EncodeJSON(map[string]any{
		"ok":      true,
		"results": results,
	}, 1024, 0)
	if err != nil {
		internalError(response)
		return
	}
	representation.Send(response, request, encoded, "")
}

func (app *App) history(response http.ResponseWriter, request *http.Request) {
	options, err := app.historyOptions(request)
	if err != nil {
		writeQueryError(response, err)
		return
	}
	result, err := tracks.AircraftHistory(
		request.Context(),
		app.db,
		request.PathValue("hex"),
		options,
	)
	if err != nil {
		writeQueryError(response, err)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	encoded, err := representation.EncodeJSON(result, 1024, 0)
	if err != nil {
		internalError(response)
		return
	}
	representation.Send(response, request, encoded, "")
}

func (app *App) historyKML(response http.ResponseWriter, request *http.Request) {
	options, err := app.historyOptions(request)
	if err != nil {
		writeQueryError(response, err)
		return
	}
	result, err := tracks.AircraftHistory(
		request.Context(),
		app.db,
		request.PathValue("hex"),
		options,
	)
	if err != nil {
		writeQueryError(response, err)
		return
	}
	bytes := []byte(tracks.TrackKML(result.Hex, result.Points))
	response.Header().Set("Content-Type", "application/vnd.google-earth.kml+xml; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Disposition", `attachment; filename="`+result.Hex+`.kml"`)
	response.Header().Set("Content-Length", strconv.Itoa(len(bytes)))
	if request.Method != http.MethodHead {
		_, _ = response.Write(bytes)
	}
}

func (app *App) historyOptions(request *http.Request) (tracks.HistoryOptions, error) {
	query := request.URL.Query()
	for key, values := range query {
		if key != "limit" && key != "olderCursor" && key != "at" {
			return tracks.HistoryOptions{}, &tracks.QueryError{Status: 400, Message: "unsupported history query parameter"}
		}
		if len(values) != 1 {
			switch key {
			case "limit":
				return tracks.HistoryOptions{}, &tracks.QueryError{Status: 400, Message: "limit must be from 1 to 5000"}
			case "olderCursor":
				return tracks.HistoryOptions{}, &tracks.QueryError{Status: 400, Message: "invalid olderCursor"}
			case "at":
				return tracks.HistoryOptions{}, &tracks.QueryError{Status: 400, Message: "invalid at"}
			}
		}
	}
	options := tracks.HistoryOptions{
		Limit:         tracks.DefaultHistoryPagePoints,
		RetentionDays: app.config.TrackRetentionDays,
		Now:           time.Now(),
	}
	if raw, exists := query["limit"]; exists {
		if !regexp.MustCompile(`^\d+$`).MatchString(raw[0]) {
			return options, &tracks.QueryError{Status: 400, Message: "limit must be from 1 to 5000"}
		}
		value, err := strconv.Atoi(raw[0])
		if err != nil || value < 1 || value > tracks.MaxHistoryPagePoints {
			return options, &tracks.QueryError{Status: 400, Message: "limit must be from 1 to 5000"}
		}
		options.Limit = value
	}
	if raw, exists := query["olderCursor"]; exists {
		if raw[0] == "" {
			return options, &tracks.QueryError{Status: 400, Message: "invalid olderCursor"}
		}
		options.OlderCursor = raw[0]
	}
	if raw, exists := query["at"]; exists {
		value, err := time.Parse(time.RFC3339Nano, raw[0])
		if err != nil {
			return options, &tracks.QueryError{Status: 400, Message: "invalid at"}
		}
		options.At = &value
	}
	return options, nil
}

func (app *App) coverageResponse(response http.ResponseWriter, request *http.Request) {
	if len(request.URL.Query()) != 0 {
		representation.WriteJSON(response, http.StatusBadRequest, map[string]any{
			"ok": false, "error": "coverage query parameters are not supported",
		})
		return
	}
	if app.coverage != nil {
		if encoded, ok := app.coverage.Representation(); ok {
			response.Header().Set("Cache-Control", "public, max-age=0, must-revalidate")
			representation.Send(response, request, encoded, "")
			return
		}
	}
	response.Header().Set("Retry-After", "5")
	response.Header().Set("Cache-Control", "no-store")
	representation.WriteJSON(response, http.StatusServiceUnavailable, map[string]any{
		"ok": false, "error": "coverage is not ready",
	})
}

func (app *App) areaTraffic(response http.ResponseWriter, request *http.Request) {
	if !app.areaFeed.Enabled() {
		representation.WriteJSON(response, http.StatusNotFound, map[string]any{
			"ok": false, "error": "area feed not configured",
		})
		return
	}
	lat, latErr := strconv.ParseFloat(request.URL.Query().Get("lat"), 64)
	lon, lonErr := strconv.ParseFloat(request.URL.Query().Get("lon"), 64)
	radius, radiusErr := strconv.ParseFloat(request.URL.Query().Get("radius"), 64)
	if latErr != nil || lat < -90 || lat > 90 ||
		lonErr != nil || lon < -180 || lon > 180 ||
		radiusErr != nil || radius <= 0 {
		representation.WriteJSON(response, http.StatusBadRequest, map[string]any{
			"ok": false, "error": "lat, lon and radius (NM) are required",
		})
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	result, err := app.areaFeed.Query(request.Context(), lat, lon, radius)
	if err != nil {
		status := http.StatusBadGateway
		retryAfter := 0
		var feedError *areafeed.Error
		if errors.As(err, &feedError) {
			if feedError.Status == http.StatusServiceUnavailable {
				status = http.StatusServiceUnavailable
			}
			retryAfter = feedError.RetryAfter
		}
		if retryAfter > 0 {
			response.Header().Set("Retry-After", strconv.Itoa(retryAfter))
		}
		message := "upstream failed"
		if status == http.StatusServiceUnavailable {
			message = "area feed busy"
		}
		representation.WriteJSON(response, status, map[string]any{"ok": false, "error": message})
		return
	}
	representation.WriteJSON(response, http.StatusOK, result)
}

func (app *App) withRouteLimit(name string, next http.Handler) http.Handler {
	limit := app.routeLimits[name]
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		ip := app.clientIP(request)
		ipResult := limit.ip.Consume(ip, 1)
		if !ipResult.OK {
			rejectLimited(response, http.StatusTooManyRequests, ipResult.RetryAfter)
			return
		}
		globalResult := limit.global.Consume("global", 1)
		if !globalResult.OK {
			rejectLimited(response, http.StatusServiceUnavailable, globalResult.RetryAfter)
			return
		}
		if !limit.acquire(ip) {
			rejectLimited(response, http.StatusServiceUnavailable, 1)
			return
		}
		defer limit.release(ip)
		next.ServeHTTP(response, request)
	})
}

func newRouteLimit(ipRefill, ipBurst, globalRefill, globalBurst float64, inFlight, perIP int) *routeLimit {
	return &routeLimit{
		ip:            limits.NewPool(ipRefill, ipBurst, 10000),
		global:        limits.NewPool(globalRefill, globalBurst, 1),
		inFlightLimit: inFlight,
		perIPLimit:    perIP,
		inFlightByIP:  make(map[string]int),
	}
}

func (limit *routeLimit) acquire(ip string) bool {
	limit.mu.Lock()
	defer limit.mu.Unlock()
	if limit.inFlightLimit > 0 && limit.inFlight >= limit.inFlightLimit {
		return false
	}
	if limit.perIPLimit > 0 && limit.inFlightByIP[ip] >= limit.perIPLimit {
		return false
	}
	limit.inFlight++
	limit.inFlightByIP[ip]++
	return true
}

func (limit *routeLimit) release(ip string) {
	limit.mu.Lock()
	defer limit.mu.Unlock()
	limit.inFlight = max(0, limit.inFlight-1)
	limit.inFlightByIP[ip]--
	if limit.inFlightByIP[ip] <= 0 {
		delete(limit.inFlightByIP, ip)
	}
}

func (app *App) clientIP(request *http.Request) string {
	remote := parseRemoteIP(request.RemoteAddr)
	if !trusted(remote, app.config.TrustProxy) {
		return remote.String()
	}
	forwarded := strings.Split(request.Header.Get("X-Forwarded-For"), ",")
	for index := len(forwarded) - 1; index >= 0; index-- {
		candidate, err := netip.ParseAddr(strings.TrimSpace(forwarded[index]))
		if err != nil {
			return remote.String()
		}
		candidate = candidate.Unmap()
		if !trusted(candidate, app.config.TrustProxy) || index == 0 {
			return candidate.String()
		}
	}
	return remote.String()
}

func parseRemoteIP(value string) netip.Addr {
	host, _, err := net.SplitHostPort(value)
	if err != nil {
		host = value
	}
	address, err := netip.ParseAddr(strings.Trim(host, "[]"))
	if err != nil {
		return netip.IPv4Unspecified()
	}
	return address.Unmap()
}

func trusted(address netip.Addr, prefixes []netip.Prefix) bool {
	for _, prefix := range prefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func bearerToken(header string) string {
	match := bearerPattern.FindStringSubmatch(header)
	if len(match) != 2 {
		return ""
	}
	return strings.TrimSpace(match[1])
}

func decodeJSON(request *http.Request, response http.ResponseWriter, maxBytes int64) (any, int, string) {
	contentType, _, _ := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if contentType != "application/json" && !strings.HasSuffix(contentType, "+json") {
		return nil, 0, ""
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, http.StatusRequestEntityTooLarge, "request body too large"
		}
		if errors.Is(err, io.EOF) {
			return nil, 0, ""
		}
		return nil, http.StatusBadRequest, "invalid JSON body"
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, http.StatusRequestEntityTooLarge, "request body too large"
		}
		return nil, http.StatusBadRequest, "invalid JSON body"
	}
	return value, 0, ""
}

func rawAircraftCount(payload map[string]any) int {
	if aircraft, ok := payload["aircraft"].([]any); ok {
		return len(aircraft)
	}
	if nested, ok := payload["payload"].(map[string]any); ok {
		if aircraft, ok := nested["aircraft"].([]any); ok {
			return len(aircraft)
		}
	}
	return 0
}

func summarize(aircraft []tracks.Aircraft) tracks.Summary {
	summary := tracks.Summary{Sources: make(map[string]int)}
	for _, item := range aircraft {
		if item.Lat != nil && item.Lon != nil {
			summary.WithPosition++
		}
		if item.OnGround {
			summary.OnGround++
		}
		if item.NonICAO {
			summary.NonICAO++
		}
		source := "unknown"
		if item.SourceKind != nil && *item.SourceKind != "" {
			source = *item.SourceKind
		}
		summary.Sources[source]++
	}
	return summary
}

func writeQueryError(response http.ResponseWriter, err error) {
	var queryError *tracks.QueryError
	if errors.As(err, &queryError) {
		representation.WriteJSON(response, queryError.Status, map[string]any{
			"ok": false, "error": queryError.Message,
		})
		return
	}
	internalError(response)
}

func rejectLimited(response http.ResponseWriter, status, retryAfter int) {
	response.Header().Set("Retry-After", strconv.Itoa(retryAfter))
	response.Header().Set("Cache-Control", "no-store")
	message := "service busy"
	if status == http.StatusTooManyRequests {
		message = "rate limit exceeded"
	}
	representation.WriteJSON(response, status, map[string]any{"ok": false, "error": message})
}

func internalError(response http.ResponseWriter) {
	representation.WriteJSON(response, http.StatusInternalServerError, map[string]any{
		"ok": false, "error": "internal server error",
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://server.arcgisonline.com https://tiles.mapterhorn.com https://tiles.openfreemap.org; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; manifest-src 'self'",
		)
		response.Header().Set("X-Content-Type-Options", "nosniff")
		response.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		response.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(self), payment=(), usb=()")
		next.ServeHTTP(response, request)
	})
}

func notFound(response http.ResponseWriter, _ *http.Request) {
	representation.WriteJSON(response, http.StatusNotFound, map[string]any{"ok": false, "error": "not found"})
}
