package representation

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNegotiate(t *testing.T) {
	tests := []struct {
		header string
		gzip   bool
		want   string
	}{
		{"gzip", true, "gzip"},
		{"gzip;q=0.5", true, "identity"},
		{"gzip;q=1, identity;q=0", true, "gzip"},
		{"*;q=0", true, ""},
		{"identity;q=0", false, ""},
		{"", true, "identity"},
	}
	for _, test := range tests {
		if got := Negotiate(test.header, test.gzip); got != test.want {
			t.Errorf("Negotiate(%q, %v) = %q, want %q", test.header, test.gzip, got, test.want)
		}
	}
}

func TestSendConditionalGzip(t *testing.T) {
	encoded, err := EncodeJSON(map[string]any{"payload": string(make([]byte, 2048))}, 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	recorder := httptest.NewRecorder()
	if !Send(recorder, request, encoded, "") {
		t.Fatal("send failed")
	}
	if recorder.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("headers = %#v", recorder.Header())
	}
	conditional := httptest.NewRequest(http.MethodGet, "/", nil)
	conditional.Header.Set("Accept-Encoding", "gzip")
	conditional.Header.Set("If-None-Match", encoded.GzipETag)
	recorder = httptest.NewRecorder()
	Send(recorder, conditional, encoded, "")
	if recorder.Code != http.StatusNotModified {
		t.Fatalf("status = %d", recorder.Code)
	}
}
