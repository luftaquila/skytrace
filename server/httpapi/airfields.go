package httpapi

import (
	"net/http"
	"strconv"

	"github.com/luftaquila/skytrace/server/representation"
)

func (app *App) airfieldManifest(response http.ResponseWriter, _ *http.Request) {
	manifest := app.airfields.Manifest()
	if manifest == nil {
		representation.WriteJSON(response, http.StatusNotFound, map[string]any{
			"ok": false, "error": "airfield dataset not built yet",
		})
		return
	}
	response.Header().Set("Cache-Control", "public, max-age=0, must-revalidate")
	representation.WriteJSON(response, http.StatusOK, manifest)
}

func (app *App) airfieldPayload(response http.ResponseWriter, request *http.Request) {
	encoding := representation.Negotiate(request.Header.Get("Accept-Encoding"), true)
	if encoding == "" {
		representation.WriteJSON(response, http.StatusNotAcceptable, map[string]any{
			"ok": false, "error": "no acceptable content encoding",
		})
		return
	}
	bytes, err := app.airfields.Payload(
		request.PathValue("version"),
		request.PathValue("file"),
		encoding,
	)
	if err != nil {
		internalError(response)
		return
	}
	if bytes == nil {
		notFound(response, request)
		return
	}
	etag := representation.StrongETag(bytes)
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "public, max-age=2592000, immutable")
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
