package database

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/luftaquila/skytrace/internal/config"
)

func TestOpenCreatesCanonicalPrivateDatabase(t *testing.T) {
	ctx := context.Background()
	dir := filepath.Join(t.TempDir(), "private")
	path := filepath.Join(dir, "skytrace.db")
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := QuickCheck(ctx, db.SQL); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("database mode = %o", info.Mode().Perm())
	}
	dirInfo, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("directory mode = %o", dirInfo.Mode().Perm())
	}
	fingerprint, err := Fingerprint(ctx, db.SQL)
	if err != nil {
		t.Fatal(err)
	}
	const nodeCanonicalFingerprint = "4d8d6007f5e0b9f3bad477a11630ff307ac92142ac72ce1b8bcfb9c0f34ad92e"
	if fingerprint != nodeCanonicalFingerprint {
		t.Fatalf("canonical fingerprint = %s, want Node fingerprint %s", fingerprint, nodeCanonicalFingerprint)
	}
}

func TestUnknownSchemaIsRejected(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "skytrace.db")
	raw, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.SQL.ExecContext(ctx, "CREATE INDEX unexpected_index ON receivers(name)"); err != nil {
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = Open(ctx, path)
	if err == nil || !strings.Contains(err.Error(), "not canonical") {
		t.Fatalf("error = %v", err)
	}
}

func TestDatabaseSymlinkIsRejected(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	target := filepath.Join(dir, "target.db")
	if err := os.WriteFile(target, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.db")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(ctx, link); err == nil || !strings.Contains(err.Error(), "regular file") {
		t.Fatalf("error = %v", err)
	}
}

func TestReceiverTokensAreAuthoritative(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	first := []config.ReceiverToken{
		{ReceiverID: "rx-1", Token: strings.Repeat("a", 32)},
		{ReceiverID: "rx-2", Token: strings.Repeat("b", 32)},
	}
	now := time.Date(2026, 7, 30, 1, 2, 3, 456000000, time.UTC)
	if err := SyncReceiverTokens(ctx, db.SQL, first, now); err != nil {
		t.Fatal(err)
	}
	if err := SyncReceiverTokens(ctx, db.SQL, first[:1], now); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.SQL.QueryRowContext(ctx, "SELECT count(*) FROM receiver_tokens").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("token count = %d", count)
	}
	var receiver string
	if err := db.SQL.QueryRowContext(ctx, "SELECT receiver_id FROM receiver_tokens").Scan(&receiver); err != nil {
		t.Fatal(err)
	}
	if receiver != "rx-1" {
		t.Fatalf("receiver = %q", receiver)
	}
}
