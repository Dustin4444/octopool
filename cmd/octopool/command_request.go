package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"strings"
)

func runRequest(ctx context.Context, args []string, stdout io.Writer) error {
	auth, err := loadAuth()
	if err != nil {
		return err
	}
	fs := flag.NewFlagSet("request", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	url := fs.String("url", defaultAuthURL(auth), "Octopool base URL")
	pool := fs.String("pool", defaultAuthPool(auth), "pool id")
	tokenEnv := fs.String("token-env", "OCTOPOOL_TOKEN", "caller token env var")
	method := fs.String("method", "GET", "GitHub method")
	path := fs.String("path", "", "GitHub API path")
	queryValues := multiFlag{}
	headerValues := multiFlag{}
	routeHintValues := multiFlag{}
	fs.Var(&queryValues, "query", "query key=value, repeatable")
	fs.Var(&headerValues, "header", "header key=value, repeatable")
	fs.Var(&routeHintValues, "route-hint", "route hint key=value, repeatable")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *path == "" {
		return errors.New("--path is required")
	}
	if err := validateAuthURLForRequest(auth, *url, *tokenEnv); err != nil {
		return err
	}
	token, err := callerToken(*tokenEnv)
	if err != nil {
		return err
	}
	body := map[string]any{
		"pool":   *pool,
		"method": strings.ToUpper(*method),
		"path":   *path,
	}
	if len(queryValues) > 0 {
		body["query"] = valuesMap(queryValues)
	}
	if len(headerValues) > 0 {
		body["headers"] = valuesMap(headerValues)
	}
	if len(routeHintValues) > 0 {
		body["route_hint"] = valuesMap(routeHintValues)
	}
	return postJSON(ctx, stdout, apiURL(*url, "/v1/github/request"), token, body)
}

type multiFlag []string

func (m *multiFlag) String() string {
	return strings.Join(*m, ",")
}

func (m *multiFlag) Set(value string) error {
	*m = append(*m, value)
	return nil
}

func valuesMap(values []string) map[string]string {
	out := make(map[string]string, len(values))
	for _, value := range values {
		key, item, ok := strings.Cut(value, "=")
		if !ok {
			out[value] = ""
			continue
		}
		out[key] = item
	}
	return out
}
