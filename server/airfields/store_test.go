package airfields

import (
	"bytes"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSourceURLSecurityBoundary(t *testing.T) {
	for _, value := range []string{
		"https://example.com/airports.csv",
		"http://127.0.0.1:8080/airports.csv",
		"http://[::1]:8080/airports.csv",
		"http://localhost/airports.csv",
	} {
		if _, err := validateSourceURL(value); err != nil {
			t.Errorf("validateSourceURL(%q): %v", value, err)
		}
	}
	for _, value := range []string{
		"http://example.com/airports.csv",
		"https://user:pass@example.com/airports.csv",
		"file:///tmp/airports.csv",
		"relative.csv",
	} {
		if _, err := validateSourceURL(value); err == nil {
			t.Errorf("validateSourceURL(%q) unexpectedly succeeded", value)
		}
	}
}

func TestParseCSVRejectsConfiguredLimits(t *testing.T) {
	if _, err := ParseCSV("a\nb\n", 1); err == nil {
		t.Fatal("row limit was not enforced")
	}
	if _, err := ParseCSV(strings.Repeat("x", maxCSVFieldChars+1)+"\n", 1); err == nil {
		t.Fatal("field limit was not enforced")
	}
	if _, err := ParseCSV("\"unterminated\n", 1); err == nil {
		t.Fatal("malformed CSV was accepted")
	}
}

func TestDatasetPayloadsAreAtomicCompressedAndConfined(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(StoreConfig{
		Dir:         dir,
		AirportsURL: "https://example.com/airports.csv",
		RunwaysURL:  "https://example.com/runways.csv",
	})
	if err != nil {
		t.Fatal(err)
	}
	version := "20260730-0123456789"
	dataset := Dataset{
		Index: [][]any{{"RKSI", "RKSI", "ICN", "Incheon", "l", "Seoul", 37.46, 126.44, []any{}}},
		Cells: map[string][][]any{
			"12-30": {{"SMALL", nil, nil, "Small", "s", nil, 37.5, 127.1, []any{}}},
		},
	}
	if _, err := store.writeDataset(version, dataset); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"index.json", "index.json.gz", "cell-12-30.json", "cell-12-30.json.gz"} {
		info, err := os.Stat(filepath.Join(dir, "v-"+version, name))
		if err != nil || !info.Mode().IsRegular() {
			t.Fatalf("%s: info=%v err=%v", name, info, err)
		}
	}
	identity, err := store.Payload(version, "index.json", "identity")
	if err != nil || !bytes.Contains(identity, []byte(`"tier":"index"`)) {
		t.Fatalf("identity payload = %q, err=%v", identity, err)
	}
	compressed, err := store.Payload(version, "index.json", "gzip")
	if err != nil {
		t.Fatal(err)
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decoded, identity) {
		t.Fatal("gzip payload does not match identity")
	}
	if payload, err := store.Payload(version, "../manifest.json", "identity"); err != nil || payload != nil {
		t.Fatalf("traversal payload = %q, err=%v", payload, err)
	}
	if matches, _ := filepath.Glob(filepath.Join(dir, "tmp-*")); len(matches) != 0 {
		t.Fatalf("temporary directories remain: %v", matches)
	}
}
