package main

import (
	"context"
	"flag"
	"io"
)

func runHealth(ctx context.Context, args []string, stdout io.Writer) error {
	auth, err := loadAuth()
	if err != nil {
		return err
	}
	fs := flag.NewFlagSet("health", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	url := fs.String("url", defaultAuthURL(auth), "Octopool base URL")
	pool := fs.String("pool", defaultAuthPool(auth), "pool id")
	tokenEnv := fs.String("token-env", "OCTOPOOL_TOKEN", "caller token env var")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := validateAuthURLForRequest(auth, *url, *tokenEnv); err != nil {
		return err
	}
	token, err := callerToken(*tokenEnv)
	if err != nil {
		return err
	}
	return getJSON(ctx, stdout, apiURL(*url, "/v1/pools/"+urlPath(*pool)+"/health"), token)
}
