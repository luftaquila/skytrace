package database

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

// The pool is wider than one connection, so the pragmas have to ride in the DSN.
// Setting them with a plain Exec would land on whichever connection served it and
// leave every other one with foreign keys off and no busy timeout.
func TestOpenAppliesPragmasToEveryConnection(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "pragma.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Held at once so the pool has to hand out distinct connections.
	var connections []*sql.Conn
	for range 4 {
		connection, err := db.SQL.Conn(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer connection.Close()
		connections = append(connections, connection)
	}

	for index, connection := range connections {
		var foreignKeys int
		if err := connection.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&foreignKeys); err != nil {
			t.Fatal(err)
		}
		if foreignKeys != 1 {
			t.Errorf("connection %d has foreign_keys=%d, want 1", index, foreignKeys)
		}
		var busyTimeout int
		if err := connection.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&busyTimeout); err != nil {
			t.Fatal(err)
		}
		if busyTimeout != 5000 {
			t.Errorf("connection %d has busy_timeout=%d, want 5000", index, busyTimeout)
		}
		var journalMode string
		if err := connection.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journalMode); err != nil {
			t.Fatal(err)
		}
		if journalMode != "wal" {
			t.Errorf("connection %d has journal_mode=%s, want wal", index, journalMode)
		}
	}
}
