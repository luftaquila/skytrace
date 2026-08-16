package database

import (
	"context"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// The server opens one pool per component against the same file, so SQLite alone
// decides which writer wins and its busy handler is not fair. WriteTx makes the
// handoff explicit: no two pools may be inside a write transaction at once.
func TestWriteTxExcludesOtherPoolsOnTheSameFile(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "exclusion.db")

	first, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()

	var held atomic.Bool
	holding, release, err := WriteTx(ctx, first.SQL)
	if err != nil {
		t.Fatal(err)
	}
	held.Store(true)

	entered := make(chan bool, 1)
	go func() {
		transaction, otherRelease, err := WriteTx(ctx, second.SQL)
		if err != nil {
			entered <- true
			return
		}
		entered <- held.Load()
		transaction.Rollback()
		otherRelease()
	}()

	// Long enough that a second pool taking the lock would show up as an overlap.
	time.Sleep(200 * time.Millisecond)
	held.Store(false)
	holding.Rollback()
	release()

	select {
	case overlapped := <-entered:
		if overlapped {
			t.Fatal("a second pool began a write transaction while the first still held one")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("second pool never acquired the write lock after the first released it")
	}
}

// In-memory databases are private to their pool, so they must not end up sharing a
// write lock with every other in-memory database in the process.
func TestWriteTxKeepsMemoryDatabasesIndependent(t *testing.T) {
	ctx := context.Background()
	first, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()

	held, release, err := WriteTx(ctx, first.SQL)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	defer held.Rollback()

	done := make(chan error, 1)
	go func() {
		transaction, otherRelease, err := WriteTx(ctx, second.SQL)
		if err != nil {
			done <- err
			return
		}
		otherRelease()
		done <- transaction.Rollback()
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a separate in-memory database blocked on another one's write lock")
	}
}
