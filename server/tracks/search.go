package tracks

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strings"
)

// Search finds aircraft that are no longer on the live picture. Callsigns only exist
// on receiver_aircraft_current rows (a rolling day of identity), while track_points
// carries the whole retention window but no callsign — so a callsign query answers
// from the current table and a hex-shaped query additionally sweeps the track archive.
const (
	searchResultLimit   = 15
	searchBranchLimit   = 10
	minSearchQueryRunes = 2
	maxSearchQueryRunes = 16
)

var hexQueryPattern = regexp.MustCompile(`^~?[0-9a-f]{2,7}$`)

type SearchResult struct {
	Hex         string  `json:"hex"`
	Flight      *string `json:"flight"`
	FirstSeenAt *string `json:"firstSeenAt"`
	LastSeenAt  string  `json:"lastSeenAt"`
	HasTrack    bool    `json:"hasTrack"`
}

// SearchAircraft answers a free-text query with archived aircraft, newest first.
// Callsign matches (current table) rank above bare hex matches (track archive).
func SearchAircraft(ctx context.Context, db *sql.DB, rawQuery string) ([]SearchResult, error) {
	query := strings.TrimSpace(rawQuery)
	runes := len([]rune(query))
	if runes < minSearchQueryRunes || runes > maxSearchQueryRunes {
		return nil, &QueryError{Status: 400, Message: "query must be 2-16 characters"}
	}

	results := []SearchResult{}
	seen := map[string]int{}
	appendResult := func(result SearchResult) {
		if index, exists := seen[result.Hex]; exists {
			// A callsign row enriches the plain-hex row for the same aircraft.
			if results[index].Flight == nil {
				results[index].Flight = result.Flight
			}
			if result.HasTrack {
				results[index].HasTrack = true
			}
			return
		}
		seen[result.Hex] = len(results)
		results = append(results, result)
	}

	// LIKE needs its own metacharacters neutralised so a literal query cannot widen
	// into a wildcard scan. The bare `flight` column rides SQLite's documented MAX()
	// row selection: with a single MAX aggregate, bare columns come from the max row,
	// so each hex reports its newest callsign.
	escaped := strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(query)
	callsignRows, err := db.QueryContext(ctx, `
		SELECT hex, flight, MAX(observed_at)
		FROM receiver_aircraft_current
		WHERE flight IS NOT NULL AND UPPER(flight) LIKE UPPER(?) || '%' ESCAPE '\'
		GROUP BY hex
		ORDER BY 3 DESC
		LIMIT ?
	`, escaped, searchBranchLimit)
	if err != nil {
		return nil, err
	}
	// Drain the cursor before the per-row span probes: a nested query while a rows
	// cursor is open needs a second pool connection, and the in-memory pool has one.
	var callsignHits []SearchResult
	for callsignRows.Next() {
		var result SearchResult
		var flight sql.NullString
		if err := callsignRows.Scan(&result.Hex, &flight, &result.LastSeenAt); err != nil {
			callsignRows.Close()
			return nil, err
		}
		if flight.Valid {
			value := strings.TrimSpace(flight.String)
			result.Flight = &value
		}
		callsignHits = append(callsignHits, result)
	}
	if err := callsignRows.Close(); err != nil {
		return nil, err
	}
	for _, result := range callsignHits {
		if err := attachTrackSpan(ctx, db, &result); err != nil {
			return nil, err
		}
		appendResult(result)
	}

	if lowered := strings.ToLower(query); hexQueryPattern.MatchString(lowered) {
		// Bytewise range instead of LIKE: 'g' sorts after every hex digit, so
		// [prefix, prefix+'g') covers exactly the prefix and stays on the hex index.
		hexRows, err := db.QueryContext(ctx, `
			SELECT DISTINCT hex FROM track_points
			WHERE hex >= ? AND hex < ?
			LIMIT ?
		`, lowered, lowered+"g", searchBranchLimit)
		if err != nil {
			return nil, err
		}
		var hexes []string
		for hexRows.Next() {
			var hex string
			if err := hexRows.Scan(&hex); err != nil {
				hexRows.Close()
				return nil, err
			}
			hexes = append(hexes, hex)
		}
		if err := hexRows.Close(); err != nil {
			return nil, err
		}
		for _, hex := range hexes {
			result := SearchResult{Hex: hex}
			if err := attachTrackSpan(ctx, db, &result); err != nil {
				return nil, err
			}
			if !result.HasTrack {
				continue
			}
			if err := attachCurrentIdentity(ctx, db, &result); err != nil {
				return nil, err
			}
			appendResult(result)
		}
	}

	// Callsign hits keep their recency order; hex hits sort in behind them by last seen.
	if len(results) > searchResultLimit {
		results = results[:searchResultLimit]
	}
	return results, nil
}

// attachTrackSpan fills first/last seen from the track archive. Both aggregates ride
// the (hex, position_at) index, so each is a single B-tree seek.
func attachTrackSpan(ctx context.Context, db *sql.DB, result *SearchResult) error {
	var first, last sql.NullString
	err := db.QueryRowContext(ctx, `
		SELECT MIN(position_at), MAX(position_at)
		FROM track_points
		WHERE hex = ?
	`, result.Hex).Scan(&first, &last)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if first.Valid {
		result.FirstSeenAt = &first.String
		result.HasTrack = true
	}
	if last.Valid && last.String > result.LastSeenAt {
		result.LastSeenAt = last.String
	}
	return nil
}

// attachCurrentIdentity backfills a callsign for a hex-matched aircraft when the
// rolling current table still remembers one.
func attachCurrentIdentity(ctx context.Context, db *sql.DB, result *SearchResult) error {
	var flight sql.NullString
	var observedAt sql.NullString
	err := db.QueryRowContext(ctx, `
		SELECT flight, MAX(observed_at)
		FROM receiver_aircraft_current
		WHERE hex = ?
		GROUP BY hex
	`, result.Hex).Scan(&flight, &observedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if flight.Valid {
		value := strings.TrimSpace(flight.String)
		if value != "" {
			result.Flight = &value
		}
	}
	if observedAt.Valid && observedAt.String > result.LastSeenAt {
		result.LastSeenAt = observedAt.String
	}
	return nil
}
