package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const defaultURL = "https://octopool.dev"

func main() {
	if err := run(context.Background(), os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) error {
	if len(args) == 0 {
		usage(stderr)
		return errors.New("missing command")
	}
	switch args[0] {
	case "health":
		return runHealth(ctx, args[1:], stdout)
	case "request":
		return runRequest(ctx, args[1:], stdout)
	case "admin":
		return runAdmin(ctx, args[1:], stdout)
	case "help", "-h", "--help":
		usage(stdout)
		return nil
	default:
		usage(stderr)
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func runHealth(ctx context.Context, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("health", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	url := fs.String("url", envDefault("OCTOPOOL_URL", defaultURL), "Octopool base URL")
	pool := fs.String("pool", envDefault("OCTOPOOL_POOL", "maintainers"), "pool id")
	tokenEnv := fs.String("token-env", "OCTOPOOL_TOKEN", "caller token env var")
	if err := fs.Parse(args); err != nil {
		return err
	}
	token, err := requiredEnv(*tokenEnv)
	if err != nil {
		return err
	}
	return getJSON(ctx, stdout, apiURL(*url, "/v1/pools/"+urlPath(*pool)+"/health"), token)
}

func runRequest(ctx context.Context, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("request", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	url := fs.String("url", envDefault("OCTOPOOL_URL", defaultURL), "Octopool base URL")
	pool := fs.String("pool", envDefault("OCTOPOOL_POOL", "maintainers"), "pool id")
	tokenEnv := fs.String("token-env", "OCTOPOOL_TOKEN", "caller token env var")
	method := fs.String("method", "GET", "GitHub method")
	path := fs.String("path", "", "GitHub API path")
	queryValues := multiFlag{}
	headerValues := multiFlag{}
	fs.Var(&queryValues, "query", "query key=value, repeatable")
	fs.Var(&headerValues, "header", "header key=value, repeatable")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *path == "" {
		return errors.New("--path is required")
	}
	token, err := requiredEnv(*tokenEnv)
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
	return postJSON(ctx, stdout, apiURL(*url, "/v1/github/request"), token, body)
}

func runAdmin(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) == 0 {
		return errors.New("missing admin subcommand")
	}
	switch args[0] {
	case "caller":
		return runAdminCaller(ctx, args[1:], stdout)
	case "identity":
		return runAdminIdentity(ctx, args[1:], stdout)
	default:
		return fmt.Errorf("unknown admin subcommand %q", args[0])
	}
}

func runAdminCaller(ctx context.Context, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("admin caller", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	url := fs.String("url", envDefault("OCTOPOOL_URL", defaultURL), "Octopool base URL")
	pool := fs.String("pool", envDefault("OCTOPOOL_POOL", "maintainers"), "pool id")
	adminTokenEnv := fs.String("admin-token-env", "OCTOPOOL_ADMIN_TOKEN", "admin token env var")
	githubLogin := fs.String("github-login", "", "GitHub login to register")
	name := fs.String("name", "", "caller display name")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *githubLogin == "" {
		return errors.New("--github-login is required")
	}
	token, err := requiredEnv(*adminTokenEnv)
	if err != nil {
		return err
	}
	body := map[string]any{"pool": *pool, "github_login": *githubLogin}
	if *name != "" {
		body["name"] = *name
	}
	return postJSON(ctx, stdout, apiURL(*url, "/v1/admin/callers"), token, body)
}

func runAdminIdentity(ctx context.Context, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("admin identity", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	url := fs.String("url", envDefault("OCTOPOOL_URL", defaultURL), "Octopool base URL")
	pool := fs.String("pool", envDefault("OCTOPOOL_POOL", "maintainers"), "pool id")
	adminTokenEnv := fs.String("admin-token-env", "OCTOPOOL_ADMIN_TOKEN", "admin token env var")
	id := fs.String("id", "", "identity id")
	login := fs.String("login", "", "GitHub login")
	secretRef := fs.String("secret-ref", "", "Worker secret binding name")
	kind := fs.String("kind", "pat", "identity kind")
	privateScopes := fs.Bool("private-scopes", false, "allow owner-wide scopes to access private repositories")
	scopeValues := multiFlag{}
	fs.Var(&scopeValues, "scope", "owner/repo or owner, repeatable")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *id == "" || *login == "" || *secretRef == "" {
		return errors.New("--id, --login, and --secret-ref are required")
	}
	token, err := requiredEnv(*adminTokenEnv)
	if err != nil {
		return err
	}
	scopes := make([]map[string]any, 0, len(scopeValues))
	for _, scope := range scopeValues {
		owner, repo, ok := strings.Cut(scope, "/")
		if !ok && !*privateScopes {
			return errors.New("--scope owner requires --private-scopes; use --scope owner/repo for repo-specific grants")
		}
		item := map[string]any{"owner": owner, "allow_private": *privateScopes && !ok}
		if ok && repo != "" {
			item["repo"] = repo
			item["allow_private"] = true
		}
		scopes = append(scopes, item)
	}
	body := map[string]any{
		"id":         *id,
		"login":      *login,
		"secret_ref": *secretRef,
		"kind":       *kind,
		"scopes":     scopes,
	}
	return postJSON(ctx, stdout, apiURL(*url, "/v1/admin/pools/"+urlPath(*pool)+"/identities"), token, body)
}

func getJSON(ctx context.Context, stdout io.Writer, url string, token string) error {
	child, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(child, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "Bearer "+token)
	return do(stdout, req)
}

func postJSON(ctx context.Context, stdout io.Writer, url string, token string, body map[string]any) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	child, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(child, http.MethodPost, url, strings.NewReader(string(encoded)))
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "Bearer "+token)
	req.Header.Set("content-type", "application/json")
	return do(stdout, req)
}

func do(stdout io.Writer, req *http.Request) error {
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return err
	}
	encoder := json.NewEncoder(stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
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

func envDefault(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func requiredEnv(name string) (string, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return "", fmt.Errorf("%s is not set", name)
	}
	return value, nil
}

func urlPath(value string) string {
	return strings.ReplaceAll(value, "/", "%2F")
}

func apiURL(base string, path string) string {
	return strings.TrimRight(base, "/") + path
}

func usage(w io.Writer) {
	fmt.Fprintln(w, "usage: octopool <health|request|admin> [flags]")
}
