package main

import (
	"context"
	"flag"
	"io"
)

func runHealth(ctx context.Context, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("health", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	url := fs.String("url", defaultAuthURL(authFile{}), "Octopool base URL")
	pool := fs.String("pool", defaultAuthPool(authFile{}), "pool id")
	tokenEnv := fs.String("token-env", "OCTOPOOL_TOKEN", "caller token env var")
	if handled, err := parseCommandFlags(fs, args, stdout, "usage: octopool health [flags]"); err != nil {
		return err
	} else if handled {
		return nil
	}
	auth, err := loadAuth()
	if err != nil {
		return err
	}
	applyAuthFlagDefaults(fs, auth, url, pool)
	if err := validateAuthURLForRequest(auth, *url, *tokenEnv); err != nil {
		return err
	}
	token, err := callerToken(*tokenEnv)
	if err != nil {
		return err
	}
	return getJSON(ctx, stdout, apiURL(*url, "/v1/pools/"+urlPath(*pool)+"/health"), token)
}
