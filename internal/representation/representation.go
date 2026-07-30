package representation

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

var ErrTooLarge = errors.New("JSON representation too large")

type Encoded struct {
	Identity     []byte
	Gzip         []byte
	IdentityETag string
	GzipETag     string
}

func EncodeJSON(value any, gzipThreshold, maxIdentityBytes int) (Encoded, error) {
	identity, err := json.Marshal(value)
	if err != nil {
		return Encoded{}, err
	}
	if maxIdentityBytes > 0 && len(identity) > maxIdentityBytes {
		return Encoded{}, fmt.Errorf("%w: %d bytes exceeds %d", ErrTooLarge, len(identity), maxIdentityBytes)
	}
	encoded := Encoded{
		Identity:     identity,
		IdentityETag: StrongETag(identity),
	}
	if len(identity) >= gzipThreshold {
		var output bytes.Buffer
		writer, err := gzip.NewWriterLevel(&output, 6)
		if err != nil {
			return Encoded{}, err
		}
		if _, err := writer.Write(identity); err != nil {
			return Encoded{}, err
		}
		if err := writer.Close(); err != nil {
			return Encoded{}, err
		}
		encoded.Gzip = output.Bytes()
		encoded.GzipETag = StrongETag(encoded.Gzip)
	}
	return encoded, nil
}

func StrongETag(bytes []byte) string {
	hash := sha256.Sum256(bytes)
	return `"sha256-` + base64.RawURLEncoding.EncodeToString(hash[:]) + `"`
}

func Negotiate(header string, gzipAvailable bool) string {
	values := parseEncodings(header)
	wildcard, hasWildcard := values["*"]
	gzipQuality := float64(0)
	if quality, ok := values["gzip"]; ok {
		gzipQuality = quality
	} else if hasWildcard {
		gzipQuality = wildcard
	}
	identityQuality := float64(1)
	if quality, ok := values["identity"]; ok {
		identityQuality = quality
	} else if hasWildcard && wildcard == 0 {
		identityQuality = 0
	}
	if gzipAvailable && gzipQuality > 0 && gzipQuality >= identityQuality {
		return "gzip"
	}
	if identityQuality > 0 {
		return "identity"
	}
	if gzipAvailable && gzipQuality > 0 {
		return "gzip"
	}
	return ""
}

func Send(response http.ResponseWriter, request *http.Request, encoded Encoded, contentType string) bool {
	encoding := Negotiate(request.Header.Get("Accept-Encoding"), len(encoded.Gzip) != 0)
	if encoding == "" {
		WriteJSON(response, http.StatusNotAcceptable, map[string]any{
			"ok": false, "error": "no acceptable content encoding",
		})
		return false
	}
	bytes := encoded.Identity
	etag := encoded.IdentityETag
	if encoding == "gzip" {
		bytes = encoded.Gzip
		etag = encoded.GzipETag
		response.Header().Set("Content-Encoding", "gzip")
	}
	if contentType == "" {
		contentType = "application/json; charset=utf-8"
	}
	response.Header().Set("Content-Type", contentType)
	response.Header().Set("Vary", "Accept-Encoding")
	response.Header().Set("ETag", etag)
	if (request.Method == http.MethodGet || request.Method == http.MethodHead) &&
		ETagMatches(request.Header.Get("If-None-Match"), etag) {
		response.WriteHeader(http.StatusNotModified)
		return true
	}
	response.Header().Set("Content-Length", strconv.Itoa(len(bytes)))
	if request.Method == http.MethodHead {
		response.WriteHeader(http.StatusOK)
		return true
	}
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write(bytes)
	return true
}

func WriteJSON(response http.ResponseWriter, status int, value any) {
	bytes, err := json.Marshal(value)
	if err != nil {
		status = http.StatusInternalServerError
		bytes = []byte(`{"ok":false,"error":"internal server error"}`)
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_, _ = response.Write(bytes)
}

func ETagMatches(header, etag string) bool {
	for _, value := range strings.Split(header, ",") {
		candidate := strings.TrimSpace(value)
		if candidate == "*" || candidate == etag {
			return true
		}
	}
	return false
}

func parseEncodings(header string) map[string]float64 {
	values := make(map[string]float64)
	for _, part := range strings.Split(header, ",") {
		segments := strings.Split(part, ";")
		name := strings.ToLower(strings.TrimSpace(segments[0]))
		if name == "" {
			continue
		}
		quality := float64(1)
		for _, parameter := range segments[1:] {
			parameter = strings.TrimSpace(parameter)
			if len(parameter) < 2 || strings.ToLower(parameter[:2]) != "q=" {
				continue
			}
			value := parameter[2:]
			if !validQuality(value) {
				continue
			}
			parsed, _ := strconv.ParseFloat(value, 64)
			quality = parsed
		}
		values[name] = quality
	}
	return values
}

func validQuality(value string) bool {
	if value == "0" || value == "1" {
		return true
	}
	if strings.HasPrefix(value, "0.") && len(value) <= 5 {
		for _, character := range value[2:] {
			if character < '0' || character > '9' {
				return false
			}
		}
		return true
	}
	if strings.HasPrefix(value, "1.") && len(value) <= 5 {
		for _, character := range value[2:] {
			if character != '0' {
				return false
			}
		}
		return true
	}
	return false
}
