package main

import (
	"compress/gzip"
	"debug/buildinfo"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const maxLicenseBytes = 64 * 1024

type module struct {
	Path    string
	Version string
	Dir     string
	Main    bool
}

type notice struct {
	Name     string   `json:"name"`
	Version  string   `json:"version"`
	License  any      `json:"license"`
	Text     string   `json:"text"`
	Homepage string   `json:"homepage,omitempty"`
	Scopes   []string `json:"scopes"`
}

type noticeFile struct {
	Packages []notice `json:"packages"`
}

func main() {
	binaryPath := flag.String("binary", "", "built Go binary whose linked modules should be listed")
	outputPath := flag.String("out", "", "notice JSON output path")
	scope := flag.String("scope", "server", "artifact scope")
	flag.Parse()
	if *binaryPath == "" || *outputPath == "" {
		fatal(errors.New("usage: notices --binary <file> --out <file> [--scope server]"))
	}
	info, err := buildinfo.ReadFile(*binaryPath)
	if err != nil {
		fatal(err)
	}
	linked := make(map[string]string)
	for _, dependency := range info.Deps {
		path, version := dependency.Path, dependency.Version
		if dependency.Replace != nil {
			path, version = dependency.Replace.Path, dependency.Replace.Version
		}
		linked[path] = version
	}
	directories := make(map[string]module)
	decoder := json.NewDecoder(os.Stdin)
	for {
		var current module
		if err := decoder.Decode(&current); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			fatal(err)
		}
		directories[current.Path] = current
	}

	payload := noticeFile{}
	if bytes, err := os.ReadFile(*outputPath); err == nil {
		if err := json.Unmarshal(bytes, &payload); err != nil {
			fatal(err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		fatal(err)
	}
	byPackage := make(map[string]notice)
	for _, existing := range payload.Packages {
		byPackage[existing.Name+"@"+existing.Version] = existing
	}
	for path, linkedVersion := range linked {
		current, ok := directories[path]
		if !ok || current.Dir == "" {
			fatal(fmt.Errorf("linked module directory unavailable: %s", path))
		}
		version := linkedVersion
		if version == "" || version == "(devel)" {
			version = current.Version
		}
		text := licenseText(current.Dir)
		if text == "" {
			fatal(fmt.Errorf("linked module has no licence text: %s", path))
		}
		entry := notice{
			Name:     path,
			Version:  version,
			License:  nil,
			Text:     text,
			Homepage: "https://" + path,
			Scopes:   []string{*scope},
		}
		key := entry.Name + "@" + entry.Version
		if previous, exists := byPackage[key]; exists {
			entry.Scopes = mergeScopes(previous.Scopes, entry.Scopes)
			if entry.Text == "" {
				entry.Text = previous.Text
			}
			if previous.License != nil {
				entry.License = previous.License
			}
		}
		byPackage[key] = entry
	}
	payload.Packages = payload.Packages[:0]
	for _, entry := range byPackage {
		payload.Packages = append(payload.Packages, entry)
	}
	sort.Slice(payload.Packages, func(i, j int) bool {
		if payload.Packages[i].Name == payload.Packages[j].Name {
			return payload.Packages[i].Version < payload.Packages[j].Version
		}
		return payload.Packages[i].Name < payload.Packages[j].Name
	})
	bytes, err := json.Marshal(payload)
	if err != nil {
		fatal(err)
	}
	bytes = append(bytes, '\n')
	if err := os.MkdirAll(filepath.Dir(*outputPath), 0o755); err != nil {
		fatal(err)
	}
	if err := os.WriteFile(*outputPath, bytes, 0o644); err != nil {
		fatal(err)
	}
	compressed, err := os.Create(*outputPath + ".gz")
	if err != nil {
		fatal(err)
	}
	writer, err := gzip.NewWriterLevel(compressed, 9)
	if err == nil {
		_, err = writer.Write(bytes)
	}
	if closeErr := writer.Close(); err == nil {
		err = closeErr
	}
	if closeErr := compressed.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		fatal(err)
	}
	fmt.Printf("notices: %d packages -> %s\n", len(payload.Packages), *outputPath)
}

func licenseText(directory string) string {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return ""
	}
	sort.Slice(entries, func(i, j int) bool {
		if len(entries[i].Name()) == len(entries[j].Name()) {
			return entries[i].Name() < entries[j].Name()
		}
		return len(entries[i].Name()) < len(entries[j].Name())
	})
	for _, entry := range entries {
		name := strings.ToLower(entry.Name())
		if entry.IsDir() ||
			!(name == "license" || name == "licence" || name == "copying" || name == "notice" ||
				strings.HasPrefix(name, "license.") || strings.HasPrefix(name, "license-") ||
				strings.HasPrefix(name, "licence.") || strings.HasPrefix(name, "licence-") ||
				strings.HasPrefix(name, "copying.") || strings.HasPrefix(name, "notice.")) {
			continue
		}
		bytes, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err == nil && len(bytes) > 0 && len(bytes) <= maxLicenseBytes {
			return strings.TrimSpace(string(bytes))
		}
	}
	return ""
}

func mergeScopes(a, b []string) []string {
	values := make(map[string]struct{})
	for _, scope := range append(a, b...) {
		values[scope] = struct{}{}
	}
	result := make([]string, 0, len(values))
	for scope := range values {
		result = append(result, scope)
	}
	sort.Strings(result)
	return result
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
