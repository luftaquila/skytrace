package httpapi

import (
	"errors"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/luftaquila/skytrace/server/representation"
)

func (app *App) registerStatic(mux *http.ServeMux) {
	index := filepath.Join(app.config.StaticDir, "index.html")
	if info, err := os.Stat(index); err != nil || !info.Mode().IsRegular() {
		return
	}
	mux.HandleFunc("GET /assets/{asset...}", app.staticAsset)
	mux.HandleFunc("HEAD /assets/{asset...}", app.staticAsset)
	mux.HandleFunc("GET /third-party-notices.json", app.notices)
	mux.HandleFunc("HEAD /third-party-notices.json", app.notices)
}

func (app *App) staticAsset(response http.ResponseWriter, request *http.Request) {
	relative := request.PathValue("asset")
	root := filepath.Join(app.config.StaticDir, "assets")
	path, ok := confinedPath(root, relative)
	if !ok {
		notFound(response, request)
		return
	}
	app.serveStaticFile(response, request, path, "public, max-age=31536000, immutable", true)
}

func (app *App) notices(response http.ResponseWriter, request *http.Request) {
	path := filepath.Join(app.config.StaticDir, "third-party-notices.json")
	app.serveStaticFile(response, request, path, "public, max-age=0, must-revalidate", true)
}

func (app *App) serveStaticFile(
	response http.ResponseWriter,
	request *http.Request,
	path, cacheControl string,
	precompressed bool,
) {
	gzipAvailable := false
	if precompressed {
		if info, err := os.Stat(path + ".gz"); err == nil && info.Mode().IsRegular() {
			gzipAvailable = true
		}
	}
	encoding := representation.Negotiate(request.Header.Get("Accept-Encoding"), gzipAvailable)
	if encoding == "" {
		representation.WriteJSON(response, http.StatusNotAcceptable, map[string]any{
			"ok": false, "error": "no acceptable content encoding",
		})
		return
	}
	selected := path
	if encoding == "gzip" {
		selected += ".gz"
	}
	bytes, err := os.ReadFile(selected)
	if errors.Is(err, os.ErrNotExist) {
		notFound(response, request)
		return
	}
	if err != nil {
		internalError(response)
		return
	}
	contentType := mime.TypeByExtension(filepath.Ext(path))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	etag := representation.StrongETag(bytes)
	response.Header().Set("Content-Type", contentType)
	response.Header().Set("Cache-Control", cacheControl)
	response.Header().Set("Vary", "Accept-Encoding")
	response.Header().Set("ETag", etag)
	if encoding == "gzip" {
		response.Header().Set("Content-Encoding", "gzip")
	}
	if representation.ETagMatches(request.Header.Get("If-None-Match"), etag) {
		response.WriteHeader(http.StatusNotModified)
		return
	}
	response.Header().Set("Content-Length", strconv.Itoa(len(bytes)))
	if request.Method != http.MethodHead {
		_, _ = response.Write(bytes)
	}
}

func (app *App) fallback(response http.ResponseWriter, request *http.Request) {
	if request.URL.Path == "/" {
		index := filepath.Join(app.config.StaticDir, "index.html")
		if info, err := os.Stat(index); err != nil || !info.Mode().IsRegular() {
			response.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, _ = response.Write([]byte("Skytrace API is running. Build web/ to serve the UI.\n"))
			return
		}
	}
	if (request.Method == http.MethodGet || request.Method == http.MethodHead) &&
		!strings.HasPrefix(request.URL.Path, "/api/") {
		path := filepath.Join(app.config.StaticDir, filepath.FromSlash(strings.TrimPrefix(request.URL.Path, "/")))
		if confined, ok := confinedPath(app.config.StaticDir, strings.TrimPrefix(request.URL.Path, "/")); ok {
			path = confined
			if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
				cache := "public, max-age=3600"
				if strings.Contains(path, string(filepath.Separator)+"assets"+string(filepath.Separator)) {
					cache = "public, max-age=31536000, immutable"
				}
				app.serveStaticFile(response, request, path, cache, false)
				return
			}
		}
		index := filepath.Join(app.config.StaticDir, "index.html")
		if info, err := os.Stat(index); err == nil && info.Mode().IsRegular() {
			app.serveStaticFile(response, request, index, "public, max-age=0, must-revalidate", false)
			return
		}
	}
	notFound(response, request)
}

func confinedPath(root, relative string) (string, bool) {
	if relative == "" {
		return "", false
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return "", false
	}
	candidate, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(relative)))
	if err != nil {
		return "", false
	}
	relativeToRoot, err := filepath.Rel(root, candidate)
	if err != nil || relativeToRoot == ".." || strings.HasPrefix(relativeToRoot, ".."+string(filepath.Separator)) {
		return "", false
	}
	return candidate, true
}
