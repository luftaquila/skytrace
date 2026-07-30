package receiveragent

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultInterval        = 3 * time.Second
	AircraftTimeout        = 10 * time.Second
	IngestTimeout          = 15 * time.Second
	MaxAircraftBytes int64 = 8 * 1024 * 1024
	MaxResponseBytes int64 = 1024 * 1024
)

var receiverIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$`)

type Receiver struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	PublicName string   `json:"publicName"`
	Lat        *float64 `json:"lat"`
	Lon        *float64 `json:"lon"`
}

type Config struct {
	IngestURL       string
	Token           string
	Interval        time.Duration
	AircraftURL     string
	AircraftFile    string
	CAFile          string
	InsecureServer  bool
	Receiver        Receiver
	AircraftTimeout time.Duration
	IngestTimeout   time.Duration
}

func Environment() map[string]string {
	env := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			env[key] = value
		}
	}
	return env
}

func LoadConfig(env map[string]string) (Config, error) {
	receiverID, err := required(env, "SKYTRACE_RECEIVER_ID")
	if err != nil {
		return Config{}, err
	}
	if !receiverIDPattern.MatchString(strings.TrimSpace(receiverID)) {
		return Config{}, errors.New("SKYTRACE_RECEIVER_ID is invalid")
	}
	receiverID = strings.TrimSpace(receiverID)

	token, err := required(env, "SKYTRACE_TOKEN")
	if err != nil {
		return Config{}, err
	}
	if len(token) < 32 {
		return Config{}, errors.New("SKYTRACE_TOKEN must be at least 32 characters")
	}

	aircraftURL := env["SKYTRACE_AIRCRAFT_URL"]
	aircraftFile := env["SKYTRACE_AIRCRAFT_FILE"]
	if (aircraftURL == "") == (aircraftFile == "") {
		return Config{}, errors.New("set exactly one of SKYTRACE_AIRCRAFT_URL or SKYTRACE_AIRCRAFT_FILE")
	}
	if aircraftURL != "" {
		aircraftURL, err = parseAircraftURL(aircraftURL)
		if err != nil {
			return Config{}, err
		}
	}

	ingestURL, err := parseServerURL(env)
	if err != nil {
		return Config{}, err
	}
	interval, err := parseInterval(env["SKYTRACE_INTERVAL_MS"])
	if err != nil {
		return Config{}, err
	}
	lat, err := optionalCoordinate(env["SKYTRACE_RECEIVER_LAT"], -90, 90, "SKYTRACE_RECEIVER_LAT")
	if err != nil {
		return Config{}, err
	}
	lon, err := optionalCoordinate(env["SKYTRACE_RECEIVER_LON"], -180, 180, "SKYTRACE_RECEIVER_LON")
	if err != nil {
		return Config{}, err
	}

	name := env["SKYTRACE_RECEIVER_NAME"]
	if name == "" {
		name = receiverID
	}
	publicName := env["SKYTRACE_RECEIVER_PUBLIC_NAME"]
	if publicName == "" {
		publicName = name
	}

	return Config{
		IngestURL:       ingestURL,
		Token:           token,
		Interval:        interval,
		AircraftURL:     aircraftURL,
		AircraftFile:    aircraftFile,
		CAFile:          env["SKYTRACE_CA_FILE"],
		InsecureServer:  strings.HasPrefix(ingestURL, "http://") && !loopbackURL(ingestURL),
		Receiver:        Receiver{ID: receiverID, Name: name, PublicName: publicName, Lat: lat, Lon: lon},
		AircraftTimeout: AircraftTimeout,
		IngestTimeout:   IngestTimeout,
	}, nil
}

func NewHTTPClient(caFile string) (*http.Client, error) {
	transport, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return nil, errors.New("default HTTP transport is unavailable")
	}
	cloned := transport.Clone()
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if cloned.TLSClientConfig != nil {
		tlsConfig = cloned.TLSClientConfig.Clone()
		tlsConfig.MinVersion = tls.VersionTLS12
	}
	if caFile != "" {
		roots, err := x509.SystemCertPool()
		if err != nil {
			return nil, fmt.Errorf("load system certificate pool: %w", err)
		}
		pemBytes, err := os.ReadFile(caFile)
		if err != nil {
			return nil, fmt.Errorf("read SKYTRACE_CA_FILE: %w", err)
		}
		if !roots.AppendCertsFromPEM(pemBytes) {
			return nil, errors.New("SKYTRACE_CA_FILE contains no certificates")
		}
		tlsConfig.RootCAs = roots
	}
	cloned.TLSClientConfig = tlsConfig
	return &http.Client{
		Transport: cloned,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}, nil
}

func required(env map[string]string, key string) (string, error) {
	value := env[key]
	if value == "" {
		return "", fmt.Errorf("%s is required", key)
	}
	return value, nil
}

func parseInterval(value string) (time.Duration, error) {
	if value == "" {
		return DefaultInterval, nil
	}
	if strings.Trim(value, "0123456789") != "" {
		return 0, errors.New("SKYTRACE_INTERVAL_MS must be an integer")
	}
	milliseconds, err := strconv.ParseInt(value, 10, 64)
	if err != nil || milliseconds < 1000 || milliseconds > 60000 {
		return 0, errors.New("SKYTRACE_INTERVAL_MS must be from 1000 to 60000")
	}
	return time.Duration(milliseconds) * time.Millisecond, nil
}

func optionalCoordinate(value string, min, max float64, key string) (*float64, error) {
	if value == "" {
		return nil, nil
	}
	number, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) || number < min || number > max {
		return nil, fmt.Errorf("%s is invalid", key)
	}
	return &number, nil
}

func parseAircraftURL(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return "", errors.New("SKYTRACE_AIRCRAFT_URL is invalid")
	}
	if parsed.User != nil {
		return "", errors.New("SKYTRACE_AIRCRAFT_URL must not contain credentials")
	}
	if parsed.Scheme != "http" || !loopback(parsed.Hostname()) {
		return "", errors.New("SKYTRACE_AIRCRAFT_URL must use loopback HTTP")
	}
	return parsed.String(), nil
}

func parseServerURL(env map[string]string) (string, error) {
	raw, err := required(env, "SKYTRACE_SERVER_URL")
	if err != nil {
		return "", err
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return "", errors.New("SKYTRACE_SERVER_URL is invalid")
	}
	if parsed.User != nil {
		return "", errors.New("SKYTRACE_SERVER_URL must not contain credentials")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", errors.New("SKYTRACE_SERVER_URL must use HTTP or HTTPS")
	}
	allowInsecure := env["SKYTRACE_ALLOW_INSECURE_SERVER"]
	if allowInsecure != "" && allowInsecure != "1" {
		return "", errors.New("SKYTRACE_ALLOW_INSECURE_SERVER must be 1 when set")
	}
	if parsed.Scheme == "http" && !loopback(parsed.Hostname()) && allowInsecure != "1" {
		return "", errors.New("SKYTRACE_SERVER_URL must use HTTPS")
	}

	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/api/ingest/readsb"
	parsed.RawPath = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func loopback(hostname string) bool {
	if strings.EqualFold(strings.TrimSuffix(hostname, "."), "localhost") {
		return true
	}
	ip := net.ParseIP(hostname)
	return ip != nil && ip.IsLoopback()
}

func loopbackURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && loopback(parsed.Hostname())
}
