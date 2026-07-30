package airfields

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	versionPattern = regexp.MustCompile(`^[0-9]{8}-[0-9a-f]{10}$`)
	payloadPattern = regexp.MustCompile(`^(index|cell-\d{1,2}-\d{1,2})\.json$`)
)

type StoreConfig struct {
	Dir         string
	AirportsURL string
	RunwaysURL  string
	Refresh     time.Duration
	Retry       time.Duration
}

type sourceResult struct {
	unchanged    bool
	body         string
	etag         *string
	lastModified *string
}

type Store struct {
	config      StoreConfig
	airportsURL string
	runwaysURL  string
	client      *http.Client

	mu         sync.RWMutex
	manifest   *Manifest
	refreshing bool
	timer      *time.Timer
	closed     bool
	cancel     context.CancelFunc
	wait       sync.WaitGroup
}

func NewStore(config StoreConfig) (*Store, error) {
	if config.Dir == "" {
		return nil, errors.New("airfields store needs a data directory")
	}
	if config.AirportsURL == "" {
		config.AirportsURL = defaultAirportsURL
	}
	if config.RunwaysURL == "" {
		config.RunwaysURL = defaultRunwaysURL
	}
	if config.Refresh <= 0 {
		config.Refresh = 7 * 24 * time.Hour
	}
	if config.Retry <= 0 {
		config.Retry = 6 * time.Hour
	}
	airportsURL, err := validateSourceURL(config.AirportsURL)
	if err != nil {
		return nil, err
	}
	runwaysURL, err := validateSourceURL(config.RunwaysURL)
	if err != nil {
		return nil, err
	}
	return &Store{
		config:      config,
		airportsURL: airportsURL,
		runwaysURL:  runwaysURL,
		client: &http.Client{
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

func (store *Store) Init() error {
	if err := os.MkdirAll(store.config.Dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(store.config.Dir, 0o700); err != nil {
		return err
	}
	store.mu.Lock()
	store.manifest = store.loadManifest()
	store.pruneTemporary()
	delay := time.Duration(0)
	if store.manifest != nil {
		delay = 5 * time.Second
	}
	store.scheduleLocked(delay)
	store.mu.Unlock()
	return nil
}

func (store *Store) Manifest() *Manifest {
	store.mu.RLock()
	defer store.mu.RUnlock()
	if store.manifest == nil {
		return nil
	}
	copyOfManifest := *store.manifest
	copyOfManifest.Cells = make(map[string]int, len(store.manifest.Cells))
	for key, value := range store.manifest.Cells {
		copyOfManifest.Cells[key] = value
	}
	return &copyOfManifest
}

func (store *Store) Refresh(ctx context.Context) error {
	store.mu.Lock()
	if store.closed {
		store.mu.Unlock()
		return errors.New("airfields store is closed")
	}
	if store.refreshing {
		store.mu.Unlock()
		return nil
	}
	store.refreshing = true
	store.mu.Unlock()
	err := store.refreshOnce(ctx)
	store.mu.Lock()
	store.refreshing = false
	if !store.closed {
		delay := store.config.Refresh
		if err != nil {
			delay = store.config.Retry
		}
		store.scheduleLocked(delay)
	}
	store.mu.Unlock()
	return err
}

func (store *Store) Payload(version, file, encoding string) ([]byte, error) {
	if !versionPattern.MatchString(version) || !payloadPattern.MatchString(file) {
		return nil, nil
	}
	if encoding == "gzip" {
		file += ".gz"
	}
	path := filepath.Join(store.config.Dir, "v-"+version, file)
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxPayloadBytes {
		return nil, errors.New("airfield payload exceeds the configured limit")
	}
	return os.ReadFile(path)
}

func (store *Store) Close() {
	store.mu.Lock()
	if store.closed {
		store.mu.Unlock()
		return
	}
	store.closed = true
	if store.timer != nil {
		store.timer.Stop()
	}
	if store.cancel != nil {
		store.cancel()
	}
	store.mu.Unlock()
	store.wait.Wait()
}

func (store *Store) refreshOnce(ctx context.Context) error {
	store.mu.RLock()
	current := store.manifest
	store.mu.RUnlock()
	now := time.Now().UTC()
	var airportState, runwayState *SourceState
	if current != nil {
		airportState = &current.Source.Airports
		runwayState = &current.Source.Runways
	}
	airports, err := store.fetchSource(ctx, store.airportsURL, airportState)
	if err != nil {
		return err
	}
	runways, err := store.fetchSource(ctx, store.runwaysURL, runwayState)
	if err != nil {
		return err
	}
	if current != nil && airports.unchanged && runways.unchanged {
		next := *current
		next.CheckedAt = iso(now)
		return store.writeManifest(&next)
	}
	if airports.unchanged || airports.body == "" {
		airports, err = store.fetchSource(ctx, store.airportsURL, nil)
		if err != nil {
			return err
		}
	}
	if runways.unchanged || runways.body == "" {
		runways, err = store.fetchSource(ctx, store.runwaysURL, nil)
		if err != nil {
			return err
		}
	}
	dataset, err := BuildTuples(airports.body, runways.body)
	if err != nil {
		return err
	}
	var currentCounts *Counts
	if current != nil {
		currentCounts = &current.Counts
	}
	if err := validateCounts(dataset.Counts, currentCounts); err != nil {
		return err
	}
	version := datasetVersion(now, airports.body, runways.body)
	cellCounts, err := store.writeDataset(version, dataset)
	if err != nil {
		return err
	}
	next := &Manifest{
		Format:      formatVersion,
		Version:     version,
		GeneratedAt: iso(now),
		CheckedAt:   iso(now),
		Source: ManifestSource{
			Airports: SourceState{ETag: airports.etag, LastModified: airports.lastModified},
			Runways:  SourceState{ETag: runways.etag, LastModified: runways.lastModified},
		},
		Counts:      dataset.Counts,
		CellSizeDeg: cellSizeDegrees,
		Cells:       cellCounts,
	}
	if current != nil {
		previous := current.Version
		next.PreviousVersion = &previous
	}
	return store.writeManifest(next)
}

func (store *Store) fetchSource(ctx context.Context, target string, cached *SourceState) (sourceResult, error) {
	requestCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, target, nil)
	if err != nil {
		return sourceResult{}, err
	}
	if cached != nil {
		if cached.ETag != nil {
			request.Header.Set("If-None-Match", *cached.ETag)
		}
		if cached.LastModified != nil {
			request.Header.Set("If-Modified-Since", *cached.LastModified)
		}
	}
	response, err := store.client.Do(request)
	if err != nil {
		return sourceResult{}, err
	}
	defer response.Body.Close()
	result := sourceResult{etag: headerPointer(response.Header.Get("ETag")), lastModified: headerPointer(response.Header.Get("Last-Modified"))}
	if response.StatusCode == http.StatusNotModified {
		result.unchanged = true
		if cached != nil {
			result.etag = cached.ETag
			result.lastModified = cached.LastModified
		}
		return result, nil
	}
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return sourceResult{}, errors.New("airfield source redirected")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return sourceResult{}, fmt.Errorf("airfield source HTTP %d", response.StatusCode)
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]))
	if contentType != "text/csv" && contentType != "text/plain" && contentType != "application/octet-stream" {
		return sourceResult{}, fmt.Errorf("airfield source has unexpected content type %s", contentType)
	}
	if response.ContentLength > maxSourceBytes {
		return sourceResult{}, errors.New("airfield source body too large")
	}
	bytes, err := io.ReadAll(io.LimitReader(response.Body, maxSourceBytes+1))
	if err != nil {
		return sourceResult{}, err
	}
	if len(bytes) > maxSourceBytes {
		return sourceResult{}, errors.New("airfield source body too large")
	}
	result.body = string(bytes)
	return result, nil
}

func (store *Store) writeDataset(version string, dataset Dataset) (map[string]int, error) {
	target := filepath.Join(store.config.Dir, "v-"+version)
	cellCounts := make(map[string]int, len(dataset.Cells))
	for id, fields := range dataset.Cells {
		cellCounts[id] = len(fields)
	}
	if info, err := os.Stat(target); err == nil && info.IsDir() {
		bytes, err := directoryBytes(target)
		if err != nil {
			return nil, err
		}
		if bytes > maxVersionBytes {
			return nil, errors.New("existing airfield version exceeds the configured byte limit")
		}
		return cellCounts, nil
	}
	temp, err := os.MkdirTemp(store.config.Dir, "tmp-")
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(temp, 0o700); err != nil {
		os.RemoveAll(temp)
		return nil, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			os.RemoveAll(temp)
		}
	}()
	var budget int64
	if err := writePayload(temp, "index.json", map[string]any{
		"format": formatVersion, "version": version, "tier": "index", "fields": dataset.Index,
	}, &budget); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(dataset.Cells))
	for id := range dataset.Cells {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		fields := dataset.Cells[id]
		if len(fields) > maxCellFields {
			return nil, fmt.Errorf("airfield cell %s exceeds the configured field limit", id)
		}
		if err := writePayload(temp, "cell-"+id+".json", map[string]any{
			"format": formatVersion, "version": version, "cell": id, "fields": fields,
		}, &budget); err != nil {
			return nil, err
		}
	}
	if err := os.Rename(temp, target); err != nil {
		return nil, err
	}
	cleanup = false
	if err := store.pruneVersions(version); err != nil {
		os.RemoveAll(target)
		return nil, err
	}
	return cellCounts, nil
}

func (store *Store) writeManifest(manifest *Manifest) error {
	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	temp := filepath.Join(store.config.Dir, fmt.Sprintf("manifest.tmp-%d", os.Getpid()))
	if err := os.WriteFile(temp, encoded, 0o600); err != nil {
		return err
	}
	if err := os.Rename(temp, filepath.Join(store.config.Dir, "manifest.json")); err != nil {
		os.Remove(temp)
		return err
	}
	store.mu.Lock()
	store.manifest = manifest
	store.mu.Unlock()
	return nil
}

func (store *Store) loadManifest() *Manifest {
	path := filepath.Join(store.config.Dir, "manifest.json")
	info, err := os.Stat(path)
	if err != nil || info.Size() > 1024*1024 {
		return nil
	}
	bytes, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var manifest Manifest
	if err := json.Unmarshal(bytes, &manifest); err != nil ||
		manifest.Format != formatVersion ||
		!versionPattern.MatchString(manifest.Version) {
		return nil
	}
	if info, err := os.Stat(filepath.Join(store.config.Dir, "v-"+manifest.Version, "index.json")); err != nil || !info.Mode().IsRegular() {
		return nil
	}
	return &manifest
}

func (store *Store) pruneTemporary() {
	entries, _ := os.ReadDir(store.config.Dir)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "tmp-") || strings.HasPrefix(entry.Name(), "manifest.tmp-") {
			_ = os.RemoveAll(filepath.Join(store.config.Dir, entry.Name()))
		}
	}
}

func (store *Store) pruneVersions(currentVersion string) error {
	entries, err := os.ReadDir(store.config.Dir)
	if err != nil {
		return err
	}
	keep := map[string]bool{currentVersion: true}
	store.mu.RLock()
	if store.manifest != nil {
		keep[store.manifest.Version] = true
		if store.manifest.PreviousVersion != nil {
			keep[*store.manifest.PreviousVersion] = true
		}
	}
	store.mu.RUnlock()
	type versionInfo struct {
		name, version, path string
		modified            time.Time
		bytes               int64
	}
	versions := []versionInfo{}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "v-") || !versionPattern.MatchString(strings.TrimPrefix(entry.Name(), "v-")) {
			continue
		}
		path := filepath.Join(store.config.Dir, entry.Name())
		info, err := entry.Info()
		if err != nil {
			return err
		}
		size, err := directoryBytes(path)
		if err != nil {
			return err
		}
		versions = append(versions, versionInfo{
			name: entry.Name(), version: strings.TrimPrefix(entry.Name(), "v-"),
			path: path, modified: info.ModTime(), bytes: size,
		})
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i].modified.Before(versions[j].modified) })
	now := time.Now()
	var total int64
	for index := range versions {
		if !keep[versions[index].version] && now.Sub(versions[index].modified) >= versionRetention {
			if err := os.RemoveAll(versions[index].path); err != nil {
				return err
			}
			versions[index].bytes = 0
		}
		total += versions[index].bytes
	}
	for index := range versions {
		if total <= maxStoreBytes {
			break
		}
		if versions[index].bytes == 0 || keep[versions[index].version] {
			continue
		}
		if err := os.RemoveAll(versions[index].path); err != nil {
			return err
		}
		total -= versions[index].bytes
	}
	if total > maxStoreBytes {
		return errors.New("retained airfield versions exceed the configured store limit")
	}
	return nil
}

func (store *Store) scheduleLocked(delay time.Duration) {
	if store.closed {
		return
	}
	if store.timer != nil {
		store.timer.Stop()
	}
	store.timer = time.AfterFunc(delay, func() {
		ctx, cancel := context.WithCancel(context.Background())
		store.mu.Lock()
		if store.closed {
			store.mu.Unlock()
			cancel()
			return
		}
		store.cancel = cancel
		store.wait.Add(1)
		store.mu.Unlock()
		defer store.wait.Done()
		defer cancel()
		_ = store.Refresh(ctx)
	})
}

func validateSourceURL(value string) (string, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("airfield sources must use credential-free HTTPS (HTTP is loopback-only)")
	}
	loopback := false
	if parsed.Hostname() == "localhost" {
		loopback = true
	} else if address := net.ParseIP(parsed.Hostname()); address != nil {
		loopback = address.IsLoopback()
	}
	if parsed.User != nil || (parsed.Scheme != "https" && !(parsed.Scheme == "http" && loopback)) {
		return "", errors.New("airfield sources must use credential-free HTTPS (HTTP is loopback-only)")
	}
	return parsed.String(), nil
}

func directoryBytes(path string) (int64, error) {
	var total int64
	err := filepath.WalkDir(path, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		total += info.Size()
		return nil
	})
	return total, err
}

func headerPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func iso(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}
