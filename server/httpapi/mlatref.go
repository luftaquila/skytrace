package httpapi

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/luftaquila/skytrace/server/ingest"
)

// The MLAT range gate needs a per-receiver anchor, but a configured receiver
// location is both optional and a fresh failure mode when mistyped. The anchor is
// derived instead: the component-wise median of the receiver's recent locally
// decoded ADS-B positions, which sits within a few tens of kilometres of the
// antenna — noise against the gate radius. The median shrugs off the very
// contamination the gate exists to stop.
const (
	mlatReferenceTTL        = 30 * time.Minute
	mlatReferenceSampleSize = 1000
	mlatReferenceMinSamples = 100
)

type mlatReferenceEntry struct {
	reference *ingest.MlatReference
	expiresAt time.Time
}

type mlatReferenceCache struct {
	mu      sync.Mutex
	entries map[string]mlatReferenceEntry
}

// reference returns the gate anchor for a receiver, refreshing at most once per
// TTL. A receiver without enough local ADS-B history gets nil, which disables the
// gate until the data exists to anchor it.
func (app *App) mlatReference(ctx context.Context, receiverID string) *ingest.MlatReference {
	cache := &app.mlatRefs
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.entries == nil {
		cache.entries = make(map[string]mlatReferenceEntry)
	}
	now := time.Now()
	if entry, ok := cache.entries[receiverID]; ok && now.Before(entry.expiresAt) {
		return entry.reference
	}
	reference := app.deriveMlatReference(ctx, receiverID)
	cache.entries[receiverID] = mlatReferenceEntry{reference: reference, expiresAt: now.Add(mlatReferenceTTL)}
	return reference
}

func (app *App) deriveMlatReference(ctx context.Context, receiverID string) *ingest.MlatReference {
	rows, err := app.db.QueryContext(ctx, `
		SELECT lat, lon FROM track_points
		WHERE receiver_id = ? AND source_type LIKE 'adsb%'
		ORDER BY id DESC
		LIMIT ?
	`, receiverID, mlatReferenceSampleSize)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var lats, lons []float64
	for rows.Next() {
		var lat, lon float64
		if err := rows.Scan(&lat, &lon); err != nil {
			return nil
		}
		lats = append(lats, lat)
		lons = append(lons, lon)
	}
	if rows.Err() != nil {
		return nil
	}
	return medianReference(lats, lons)
}

func medianReference(lats, lons []float64) *ingest.MlatReference {
	if len(lats) < mlatReferenceMinSamples || len(lats) != len(lons) {
		return nil
	}
	return &ingest.MlatReference{Lat: median(lats), Lon: median(lons)}
}

func median(values []float64) float64 {
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	middle := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[middle]
	}
	return (sorted[middle-1] + sorted[middle]) / 2
}
