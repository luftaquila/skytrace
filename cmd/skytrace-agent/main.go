package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/luftaquila/skytrace/internal/receiveragent"
)

var version = "dev"

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	flags := flag.NewFlagSet("skytrace-agent", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	once := flags.Bool("once", false, "upload one batch and exit")
	showVersion := flags.Bool("version", false, "print the agent version and exit")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "skytrace-agent: unexpected positional arguments")
		return 2
	}
	if *showVersion {
		fmt.Printf("skytrace-agent %s\n", version)
		return 0
	}

	config, err := receiveragent.LoadConfig(receiveragent.Environment())
	if err != nil {
		fmt.Fprintf(os.Stderr, "skytrace-agent: startup failed: %s\n", receiveragent.RedactError(err))
		return 1
	}
	client, err := receiveragent.NewHTTPClient(config.CAFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "skytrace-agent: startup failed: %s\n", receiveragent.RedactError(err))
		return 1
	}
	if config.InsecureServer {
		fmt.Fprintln(os.Stderr, "Skytrace agent is using explicitly allowed insecure HTTP transport")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	agent := receiveragent.New(config, client, os.Stdout, os.Stderr)
	err = agent.Run(ctx, *once)
	if err == nil {
		return 0
	}
	if errors.Is(err, receiveragent.ErrOnceFailed) {
		return 1
	}
	fmt.Fprintf(os.Stderr, "skytrace-agent: failed: %s\n", receiveragent.RedactError(err))
	return 1
}
