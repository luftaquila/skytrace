package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/luftaquila/skytrace/server/airfields"
	"github.com/luftaquila/skytrace/server/config"
	"github.com/luftaquila/skytrace/server/coverage"
	"github.com/luftaquila/skytrace/server/database"
	"github.com/luftaquila/skytrace/server/httpapi"
	"github.com/luftaquila/skytrace/server/retention"
	"github.com/luftaquila/skytrace/server/sse"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 1 && args[0] == "healthcheck" {
		return healthcheck()
	}
	if len(args) != 0 {
		fmt.Fprintln(os.Stderr, "usage: skytrace [healthcheck]")
		return 2
	}

	syscall.Umask(0o077)
	cfg, err := config.Load(config.Environment())
	if err != nil {
		log.Printf("startup failed: %v", err)
		return 1
	}
	if err := cfg.Validate(); err != nil {
		log.Printf("startup failed: %v", err)
		return 1
	}
	ctx := context.Background()
	db, err := database.Open(ctx, cfg.DBPath)
	if err != nil {
		log.Printf("startup failed: %v", err)
		return 1
	}
	defer db.Close()
	if err := database.SyncReceiverTokens(ctx, db.SQL, cfg.ReceiverTokens, time.Now()); err != nil {
		log.Printf("startup failed: %v", err)
		return 1
	}
	if len(cfg.ReceiverTokens) == 0 {
		log.Print("SKYTRACE_RECEIVER_TOKENS is empty; ingest is disabled")
	}
	coverageCache, err := coverage.NewCache(
		cfg.DBPath,
		coverage.OptionsFromConfig(cfg),
		cfg.CoverageRefreshSeconds,
	)
	if err != nil {
		log.Printf("startup failed: %v", err)
		return 1
	}
	defer coverageCache.Close()
	airfieldStore, err := airfields.NewStore(airfields.StoreConfig{
		Dir:         cfg.AirfieldsDir,
		AirportsURL: cfg.AirfieldsAirportsURL,
		RunwaysURL:  cfg.AirfieldsRunwaysURL,
		Refresh:     time.Duration(cfg.AirfieldsRefreshSeconds) * time.Second,
	})
	if err != nil {
		log.Printf("startup failed: %v", err)
		return 1
	}
	if err := airfieldStore.Init(); err != nil {
		log.Printf("startup failed: %v", err)
		return 1
	}
	defer airfieldStore.Close()
	retentionRunner, err := retention.New(ctx, cfg.DBPath, retention.Config{
		TrackRetentionDays:    cfg.TrackRetentionDays,
		BatchRetentionDays:    cfg.BatchRetentionDays,
		CurrentRetentionHours: cfg.CurrentRetentionHours,
	})
	if err != nil {
		log.Printf("startup failed: %v", err)
		return 1
	}
	defer retentionRunner.Close()

	hub := sse.New()
	app, err := httpapi.New(db.SQL, cfg, hub, airfieldStore)
	if err != nil {
		log.Printf("startup failed: %v", err)
		return 1
	}
	app.SetCoverageCache(coverageCache)
	server := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           limitRequestsPerConnection(app, 1000),
		ReadHeaderTimeout: 15 * time.Second,
		ReadTimeout:       60 * time.Second,
		IdleTimeout:       5 * time.Second,
		MaxHeaderBytes:    1 << 20,
		ConnContext: func(ctx context.Context, _ net.Conn) context.Context {
			return context.WithValue(ctx, requestCountKey{}, &atomic.Uint64{})
		},
	}
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		log.Printf("listen failed: %v", err)
		return 1
	}
	listener = newLimitListener(listener, 512)
	log.Printf("skytrace listening on :%d", cfg.Port)

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	result := make(chan error, 1)
	go func() {
		result <- server.Serve(listener)
	}()
	select {
	case err := <-result:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("server failed: %v", err)
			return 1
		}
	case received := <-signals:
		log.Printf("received %s, shutting down", received)
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		hub.Close()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("shutdown failed: %v", err)
			return 1
		}
	}
	return 0
}

func healthcheck() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	client := &http.Client{Timeout: 4 * time.Second}
	response, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		return 1
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

type requestCountKey struct{}

func limitRequestsPerConnection(next http.Handler, maximum uint64) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		counter, _ := request.Context().Value(requestCountKey{}).(*atomic.Uint64)
		if counter != nil && counter.Add(1) >= maximum {
			response.Header().Set("Connection", "close")
		}
		next.ServeHTTP(response, request)
	})
}

type limitListener struct {
	net.Listener
	slots chan struct{}
}

func newLimitListener(listener net.Listener, maximum int) net.Listener {
	return &limitListener{Listener: listener, slots: make(chan struct{}, maximum)}
}

func (listener *limitListener) Accept() (net.Conn, error) {
	listener.slots <- struct{}{}
	connection, err := listener.Listener.Accept()
	if err != nil {
		<-listener.slots
		return nil, err
	}
	return &limitedConnection{Conn: connection, release: func() { <-listener.slots }}, nil
}

type limitedConnection struct {
	net.Conn
	once    sync.Once
	release func()
}

func (connection *limitedConnection) Close() error {
	err := connection.Conn.Close()
	connection.once.Do(connection.release)
	return err
}
