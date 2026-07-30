package retention

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/luftaquila/skytrace/server/database"
)

func TestRunPrunesTimestampsAndFutureRows(t *testing.T) {
	ctx := context.Background()
	db, err := database.Open(ctx, filepath.Join(t.TempDir(), "skytrace.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, receiver := range []string{"rx-1", "rx-2", "rx-3"} {
		if _, err := db.SQL.Exec("INSERT INTO receivers (id) VALUES (?)", receiver); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	insertTrack := func(receiver, hex string, at time.Time) {
		t.Helper()
		text := iso(at)
		if _, err := db.SQL.Exec(`
			INSERT INTO track_points (
			  hex, receiver_id, observed_at, position_at, lat, lon
			) VALUES (?, ?, ?, ?, 37.5, 127.1)
		`, hex, receiver, text, text); err != nil {
			t.Fatal(err)
		}
	}
	insertTrack("rx-1", "aaa001", now.Add(-100*24*time.Hour))
	insertTrack("rx-1", "aaa002", now.Add(-89*24*time.Hour))
	insertTrack("rx-3", "aaa003", now.Add(-200*24*time.Hour))
	insertTrack("rx-2", "aaa004", now.Add(10*time.Minute))
	if _, err := db.SQL.Exec(`
		INSERT INTO coverage_receiver_state (
		  receiver_id, config_key, origin_lat, origin_lon, last_track_id, updated_at
		) VALUES ('rx-1', 'test', 37.5, 127, 0, ?)
	`, iso(now)); err != nil {
		t.Fatal(err)
	}
	for index, age := range []time.Duration{6 * 24 * time.Hour, 8 * 24 * time.Hour} {
		if _, err := db.SQL.Exec(`
			INSERT INTO ingest_batches (
			  receiver_id, received_at, aircraft_count, accepted_count
			) VALUES ('rx-1', ?, 0, 0)
		`, iso(now.Add(-age))); err != nil {
			t.Fatal(err)
		}
		_ = index
	}
	for index, offset := range []time.Duration{-23 * time.Hour, -25 * time.Hour, 10 * time.Minute} {
		receiver := "rx-1"
		if index == 2 {
			receiver = "rx-2"
		}
		if _, err := db.SQL.Exec(`
			INSERT INTO receiver_aircraft_current (receiver_id, hex, observed_at)
			VALUES (?, ?, ?)
		`, receiver, fmt.Sprintf("bbb%03d", index+1), iso(now.Add(offset))); err != nil {
			t.Fatal(err)
		}
	}
	result, err := Run(ctx, db.SQL, now, Config{
		TrackRetentionDays: 90, BatchRetentionDays: 7, CurrentRetentionHours: 24,
		Budget: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Complete || result.TrackOld != 2 || result.TrackFuture != 1 ||
		result.Batches != 1 || result.CurrentOld != 1 || result.CurrentFuture != 1 {
		t.Fatalf("result = %#v", result)
	}
	if len(result.CursorWarnings) != 1 || len(result.FutureRows) != 2 {
		t.Fatalf("diagnostics = %#v", result)
	}
}

func TestShortBudgetResumesAndRunnerCloseIsIdempotent(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "skytrace.db")
	db, err := database.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL.Exec("INSERT INTO receivers (id) VALUES ('rx-1')"); err != nil {
		t.Fatal(err)
	}
	old := iso(time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC))
	transaction, err := db.SQL.Begin()
	if err != nil {
		t.Fatal(err)
	}
	statement, err := transaction.Prepare(`
		INSERT INTO track_points (
		  hex, receiver_id, observed_at, position_at, lat, lon
		) VALUES (?, 'rx-1', ?, ?, 37.5, 127.1)
	`)
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < chunkSize+1; index++ {
		hex := fmt.Sprintf("%06x", index+1)
		if _, err := statement.Exec(hex, old, old); err != nil {
			t.Fatal(err)
		}
	}
	if err := statement.Close(); err != nil {
		t.Fatal(err)
	}
	if err := transaction.Commit(); err != nil {
		t.Fatal(err)
	}
	first, err := Run(ctx, db.SQL, time.Date(2026, 7, 30, 0, 0, 0, 0, time.UTC), Config{
		TrackRetentionDays: 90, BatchRetentionDays: 7, CurrentRetentionHours: 24,
		Budget: time.Nanosecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Complete || first.TrackOld != chunkSize {
		t.Fatalf("first result = %#v", first)
	}
	second, err := Run(ctx, db.SQL, time.Date(2026, 7, 30, 0, 0, 0, 0, time.UTC), Config{
		TrackRetentionDays: 90, BatchRetentionDays: 7, CurrentRetentionHours: 24,
		Budget: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !second.Complete || second.TrackOld != 1 {
		t.Fatalf("second result = %#v", second)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	runner, err := New(ctx, path, Config{FirstRun: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Close(); err != nil {
		t.Fatal(err)
	}
	if err := runner.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := runner.RunNow(ctx); err == nil {
		t.Fatal("closed retention runner accepted a run")
	}
}
