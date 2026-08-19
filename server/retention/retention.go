package retention

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/luftaquila/skytrace/server/database"
)

const chunkSize = 2000

type Config struct {
	TrackRetentionDays    int
	BatchRetentionDays    int
	CurrentRetentionHours int
	Budget                time.Duration
	FirstRun              time.Duration
	Interval              time.Duration
	Retry                 time.Duration
}

type CursorWarning struct {
	ReceiverID     string `json:"receiverId"`
	Count          int64  `json:"count"`
	MaxID          int64  `json:"maxId"`
	CoverageCursor int64  `json:"coverageCursor"`
}

type FutureRow struct {
	Table        string `json:"table"`
	ReceiverID   string `json:"receiverId"`
	Count        int64  `json:"count"`
	MaxTimestamp string `json:"maxTimestamp"`
}

type Storage struct {
	PageCount     int64 `json:"pageCount"`
	FreelistCount int64 `json:"freelistCount"`
}

type Result struct {
	Now            string          `json:"now"`
	Complete       bool            `json:"complete"`
	TrackOld       int64           `json:"trackOld"`
	TrackFuture    int64           `json:"trackFuture"`
	Batches        int64           `json:"batches"`
	CurrentOld     int64           `json:"currentOld"`
	CurrentFuture  int64           `json:"currentFuture"`
	CursorWarnings []CursorWarning `json:"cursorWarnings"`
	FutureRows     []FutureRow     `json:"futureRows"`
	Storage        Storage         `json:"storage"`
}

type Runner struct {
	db     *database.DB
	config Config
	now    func() time.Time

	mu          sync.Mutex
	running     bool
	runDone     chan struct{}
	closed      bool
	timer       *time.Timer
	last        *Result
	lastErrorAt *time.Time
}

func New(ctx context.Context, dbPath string, config Config) (*Runner, error) {
	if config.Budget <= 0 {
		config.Budget = 30 * time.Second
	}
	if config.FirstRun <= 0 {
		config.FirstRun = 5 * time.Minute
	}
	if config.Interval <= 0 {
		config.Interval = 6 * time.Hour
	}
	if config.Retry <= 0 {
		config.Retry = time.Minute
	}
	db, err := database.Open(ctx, dbPath)
	if err != nil {
		return nil, err
	}
	runner := &Runner{db: db, config: config, now: time.Now}
	runner.schedule(config.FirstRun)
	return runner, nil
}

func (runner *Runner) RunNow(ctx context.Context) (Result, error) {
	runner.mu.Lock()
	if runner.closed {
		runner.mu.Unlock()
		return Result{}, errors.New("retention is closed")
	}
	if runner.running {
		if runner.last != nil {
			result := *runner.last
			runner.mu.Unlock()
			return result, nil
		}
		runner.mu.Unlock()
		return Result{}, errors.New("retention is already running")
	}
	runner.running = true
	done := make(chan struct{})
	runner.runDone = done
	runner.mu.Unlock()

	result, err := Run(ctx, runner.db.SQL, runner.now(), runner.config)
	runner.mu.Lock()
	defer runner.mu.Unlock()
	runner.running = false
	runner.runDone = nil
	close(done)
	if err != nil {
		at := runner.now()
		runner.lastErrorAt = &at
		if !runner.closed {
			runner.scheduleLocked(runner.config.Retry)
		}
		return Result{}, err
	}
	runner.last = &result
	runner.lastErrorAt = nil
	if !runner.closed {
		delay := runner.config.Interval
		if !result.Complete {
			delay = runner.config.Retry
		}
		runner.scheduleLocked(delay)
	}
	return result, nil
}

func (runner *Runner) Close() error {
	runner.mu.Lock()
	if runner.closed {
		runner.mu.Unlock()
		return nil
	}
	runner.closed = true
	if runner.timer != nil {
		runner.timer.Stop()
	}
	done := runner.runDone
	runner.mu.Unlock()
	if done != nil {
		<-done
	}
	return runner.db.Close()
}

func (runner *Runner) schedule(delay time.Duration) {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	runner.scheduleLocked(delay)
}

func (runner *Runner) scheduleLocked(delay time.Duration) {
	if runner.closed {
		return
	}
	if runner.timer != nil {
		runner.timer.Stop()
	}
	runner.timer = time.AfterFunc(delay, func() {
		result, err := runner.RunNow(context.Background())
		if err != nil {
			log.Print("retention failed")
			return
		}
		log.Printf("retention completed: complete=%v trackOld=%d batches=%d", result.Complete, result.TrackOld, result.Batches)
		for _, warning := range result.CursorWarnings {
			log.Printf(
				"retention removed rows ahead of coverage cursor: receiver=%s count=%d maxId=%d cursor=%d",
				warning.ReceiverID,
				warning.Count,
				warning.MaxID,
				warning.CoverageCursor,
			)
		}
	})
}

func Run(ctx context.Context, db *sql.DB, now time.Time, config Config) (Result, error) {
	futureCutoff := iso(now.Add(5 * time.Minute))
	trackCutoff := iso(now.Add(-time.Duration(config.TrackRetentionDays) * 24 * time.Hour))
	batchCutoff := iso(now.Add(-time.Duration(config.BatchRetentionDays) * 24 * time.Hour))
	currentCutoff := iso(now.Add(-time.Duration(config.CurrentRetentionHours) * time.Hour))
	deadline := time.Now().Add(config.Budget)
	result := Result{
		Now:            iso(now),
		Complete:       true,
		CursorWarnings: []CursorWarning{},
		FutureRows:     []FutureRow{},
	}

	rows, err := db.QueryContext(ctx, `
		SELECT t.receiver_id, COUNT(*), MAX(t.id), s.last_track_id
		FROM track_points t
		JOIN coverage_receiver_state s ON s.receiver_id = t.receiver_id
		WHERE t.position_at < ? AND t.id > s.last_track_id
		GROUP BY t.receiver_id
		ORDER BY t.receiver_id
	`, trackCutoff)
	if err != nil {
		return Result{}, err
	}
	for rows.Next() {
		var warning CursorWarning
		if err := rows.Scan(&warning.ReceiverID, &warning.Count, &warning.MaxID, &warning.CoverageCursor); err != nil {
			rows.Close()
			return Result{}, err
		}
		result.CursorWarnings = append(result.CursorWarnings, warning)
	}
	if err := rows.Close(); err != nil {
		return Result{}, err
	}
	for _, query := range []struct {
		table  string
		column string
	}{
		{"track_points", "position_at"},
		{"receiver_aircraft_current", "observed_at"},
	} {
		rows, err := db.QueryContext(ctx, `
			SELECT receiver_id, COUNT(*), MAX(`+query.column+`)
			FROM `+query.table+`
			WHERE `+query.column+` > ?
			GROUP BY receiver_id
			ORDER BY receiver_id
		`, futureCutoff)
		if err != nil {
			return Result{}, err
		}
		for rows.Next() {
			future := FutureRow{Table: query.table}
			if err := rows.Scan(&future.ReceiverID, &future.Count, &future.MaxTimestamp); err != nil {
				rows.Close()
				return Result{}, err
			}
			result.FutureRows = append(result.FutureRows, future)
		}
		if err := rows.Close(); err != nil {
			return Result{}, err
		}
	}

	tasks := []struct {
		target *int64
		query  string
		cutoff string
	}{
		{&result.TrackOld, `
			DELETE FROM track_points WHERE id IN (
			  SELECT id FROM track_points WHERE position_at < ? ORDER BY position_at ASC LIMIT ?
			)`, trackCutoff},
		{&result.TrackFuture, `
			DELETE FROM track_points WHERE id IN (
			  SELECT id FROM track_points WHERE position_at > ? ORDER BY position_at DESC LIMIT ?
			)`, futureCutoff},
		{&result.Batches, `
			DELETE FROM ingest_batches WHERE id IN (
			  SELECT id FROM ingest_batches WHERE received_at < ? ORDER BY received_at ASC LIMIT ?
			)`, batchCutoff},
		{&result.CurrentOld, `
			DELETE FROM receiver_aircraft_current WHERE rowid IN (
			  SELECT rowid FROM receiver_aircraft_current
			  WHERE observed_at < ? ORDER BY observed_at ASC LIMIT ?
			)`, currentCutoff},
		{&result.CurrentFuture, `
			DELETE FROM receiver_aircraft_current WHERE rowid IN (
			  SELECT rowid FROM receiver_aircraft_current
			  WHERE observed_at > ? ORDER BY observed_at DESC LIMIT ?
			)`, futureCutoff},
	}
	for _, task := range tasks {
		deleted, complete, err := deleteChunks(ctx, db, task.query, task.cutoff, deadline)
		if err != nil {
			return Result{}, err
		}
		*task.target = deleted
		if !complete {
			result.Complete = false
		}
	}
	if err := db.QueryRowContext(ctx, "PRAGMA page_count").Scan(&result.Storage.PageCount); err != nil {
		return Result{}, err
	}
	if err := db.QueryRowContext(ctx, "PRAGMA freelist_count").Scan(&result.Storage.FreelistCount); err != nil {
		return Result{}, err
	}
	return result, nil
}

func deleteChunks(
	ctx context.Context,
	db *sql.DB,
	query, cutoff string,
	deadline time.Time,
) (int64, bool, error) {
	var deleted int64
	first := true
	for first || time.Now().Before(deadline) {
		first = false
		// Locked per chunk, not around the loop, so ingest gets the write lock
		// between chunks instead of waiting out the whole sweep.
		result, err := database.WriteExec(ctx, db, "retention", query, cutoff, chunkSize)
		if err != nil {
			return deleted, false, err
		}
		changes, err := result.RowsAffected()
		if err != nil {
			return deleted, false, err
		}
		deleted += changes
		if changes < chunkSize {
			return deleted, true, nil
		}
	}
	return deleted, false, nil
}

func iso(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}
