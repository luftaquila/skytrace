package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"os"
	"strings"
	"time"
)

var (
	ErrBodyTooLarge = errors.New("body too large")
	ErrInvalidJSON  = errors.New("invalid JSON")
	ErrOnceFailed   = errors.New("one-shot upload failed")
)

type Result struct {
	ReceiverID    string `json:"receiverId"`
	AcceptedCount int    `json:"acceptedCount"`
	TrackPoints   int    `json:"trackPoints"`
	ReceivedAt    string `json:"receivedAt"`
}

type Agent struct {
	Config Config
	Client *http.Client
	Stdout io.Writer
	Stderr io.Writer
	Now    func() time.Time
	Sleep  func(context.Context, time.Duration) error
	Jitter func(time.Duration) time.Duration
}

func New(config Config, client *http.Client, stdout, stderr io.Writer) *Agent {
	return &Agent{
		Config: config,
		Client: client,
		Stdout: stdout,
		Stderr: stderr,
		Now:    time.Now,
		Sleep:  sleepContext,
		Jitter: func(max time.Duration) time.Duration {
			if max <= 0 {
				return 0
			}
			return time.Duration(rand.Int64N(int64(max)))
		},
	}
}

func (agent *Agent) Run(ctx context.Context, once bool) error {
	failures := 0
	for {
		result, err := agent.RunOnce(ctx)
		if err == nil {
			failures = 0
			if encodeErr := json.NewEncoder(agent.Stdout).Encode(map[string]any{
				"ok":            true,
				"receiverId":    result.ReceiverID,
				"acceptedCount": result.AcceptedCount,
				"trackPoints":   result.TrackPoints,
				"receivedAt":    result.ReceivedAt,
			}); encodeErr != nil {
				return fmt.Errorf("write result: %w", encodeErr)
			}
		} else {
			if ctx.Err() != nil {
				return nil
			}
			failures++
			fmt.Fprintf(agent.Stderr, "[%s] %s\n", agent.Now().UTC().Format(time.RFC3339Nano), ErrorClass(err))
			if once {
				return ErrOnceFailed
			}
		}
		if once {
			return nil
		}

		exponent := min(failures, 6)
		backoff := agent.Config.Interval * time.Duration(1<<exponent)
		backoff = min(backoff, 5*time.Minute)
		if err := agent.Sleep(ctx, backoff+agent.Jitter(backoff/5)); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
	}
}

func (agent *Agent) RunOnce(ctx context.Context) (Result, error) {
	payload, err := agent.ReadAircraftJSON(ctx)
	if err != nil {
		return Result{}, err
	}
	return agent.PostBatch(ctx, payload)
}

func (agent *Agent) ReadAircraftJSON(ctx context.Context) (json.RawMessage, error) {
	if agent.Config.AircraftURL != "" {
		timeout := agent.Config.AircraftTimeout
		if timeout <= 0 {
			timeout = AircraftTimeout
		}
		requestCtx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, agent.Config.AircraftURL, nil)
		if err != nil {
			return nil, errors.New("aircraft source request failed")
		}
		request.Header.Set("Cache-Control", "no-store")
		response, err := agent.Client.Do(request)
		if err != nil {
			return nil, err
		}
		defer response.Body.Close()
		if response.StatusCode >= 300 && response.StatusCode < 400 {
			return nil, errors.New("aircraft source redirected")
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, httpStatusError{scope: "aircraft source", status: response.StatusCode}
		}
		return readJSON(response.Body, response.ContentLength, MaxAircraftBytes)
	}

	file, err := os.Open(agent.Config.AircraftFile)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > MaxAircraftBytes {
		return nil, fmt.Errorf("aircraft file is invalid or too large: %w", ErrBodyTooLarge)
	}
	return readJSON(file, info.Size(), MaxAircraftBytes)
}

func (agent *Agent) PostBatch(ctx context.Context, payload json.RawMessage) (Result, error) {
	receiver, err := json.Marshal(agent.Config.Receiver)
	if err != nil {
		return Result{}, err
	}
	body := make([]byte, 0, len(receiver)+len(payload)+24)
	body = append(body, `{"receiver":`...)
	body = append(body, receiver...)
	body = append(body, `,"payload":`...)
	body = append(body, payload...)
	body = append(body, '}')
	if int64(len(body)) > MaxAircraftBytes {
		return Result{}, ErrBodyTooLarge
	}

	timeout := agent.Config.IngestTimeout
	if timeout <= 0 {
		timeout = IngestTimeout
	}
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, agent.Config.IngestURL, bytes.NewReader(body))
	if err != nil {
		return Result{}, errors.New("ingest request failed")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+agent.Config.Token)
	request.Header.Set("X-Skytrace-Receiver", agent.Config.Receiver.ID)

	response, err := agent.Client.Do(request)
	if err != nil {
		return Result{}, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return Result{}, errors.New("ingest redirect refused")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Result{}, httpStatusError{scope: "ingest", status: response.StatusCode}
	}
	bytes, err := readJSON(response.Body, response.ContentLength, MaxResponseBytes)
	if err != nil {
		return Result{}, err
	}
	var result Result
	if err := json.Unmarshal(bytes, &result); err != nil {
		return Result{}, ErrInvalidJSON
	}
	return result, nil
}

func ErrorClass(err error) string {
	var status httpStatusError
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.As(err, &status):
		return fmt.Sprintf("HTTP %d", status.status)
	case errors.Is(err, ErrBodyTooLarge):
		return "body-too-large"
	default:
		return "request-failed"
	}
}

type httpStatusError struct {
	scope  string
	status int
}

func (err httpStatusError) Error() string {
	return fmt.Sprintf("%s HTTP %d", err.scope, err.status)
}

func readJSON(reader io.Reader, contentLength, maxBytes int64) (json.RawMessage, error) {
	if contentLength > maxBytes {
		return nil, ErrBodyTooLarge
	}
	bytes, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(bytes)) > maxBytes {
		return nil, ErrBodyTooLarge
	}
	if !json.Valid(bytes) {
		return nil, ErrInvalidJSON
	}
	return json.RawMessage(bytes), nil
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func RedactError(err error) string {
	if err == nil {
		return ""
	}
	message := err.Error()
	for _, prefix := range []string{"Bearer ", "SKYTRACE_TOKEN="} {
		if strings.Contains(message, prefix) {
			return ErrorClass(err)
		}
	}
	return message
}
