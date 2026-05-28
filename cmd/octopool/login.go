package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type loginResponse struct {
	Caller struct {
		GitHubLogin string `json:"github_login"`
		Pool        string `json:"pool"`
	} `json:"caller"`
	Token string `json:"token"`
}

type apiErrorResponse struct {
	Error struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		RequestID string `json:"request_id"`
	} `json:"error"`
}

func runLogin(ctx context.Context, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	baseURL := fs.String("url", envDefault("OCTOPOOL_URL", defaultURL), "Octopool base URL")
	pool := fs.String("pool", envDefault("OCTOPOOL_POOL", "maintainers"), "pool id")
	ghPath := fs.String("gh-path", envDefault("OCTOPOOL_GH_PATH", "gh"), "GitHub CLI path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := validateLoginURL(*baseURL); err != nil {
		return err
	}
	token, err := localGitHubToken(ctx, *ghPath)
	if err != nil {
		return err
	}
	body := map[string]any{
		"github_token": token,
		"pool":         *pool,
	}
	out, status, err := doRaw(ctx, apiURL(*baseURL, "/v1/login/github-cli"), "", body)
	if err != nil {
		return err
	}
	if status >= 400 {
		return formatLoginFailure(status, out, *ghPath)
	}
	var response loginResponse
	if err := json.Unmarshal(out, &response); err != nil {
		return err
	}
	if response.Token == "" {
		return errors.New("login response did not include a caller token")
	}
	if err := saveAuth(authFile{
		URL:       strings.TrimRight(*baseURL, "/"),
		Pool:      *pool,
		Token:     response.Token,
		Login:     response.Caller.GitHubLogin,
		CreatedAt: time.Now().UTC(),
	}); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "logged in to %s as %s for pool %s\n", strings.TrimRight(*baseURL, "/"), response.Caller.GitHubLogin, *pool)
	return nil
}

func formatLoginFailure(status int, body []byte, ghPath string) error {
	trimmed := strings.TrimSpace(string(body))
	var response apiErrorResponse
	if err := json.Unmarshal(body, &response); err != nil || response.Error.Code == "" {
		return fmt.Errorf("login failed: HTTP %d: %s", status, trimmed)
	}
	message := response.Error.Message
	if message == "" {
		message = response.Error.Code
	}
	requestID := ""
	if response.Error.RequestID != "" {
		requestID = "\nOctopool request id: " + response.Error.RequestID
	}
	if response.Error.Code == "github_auth_failed" {
		resolvedGHPath := ghPath
		if resolved, err := resolveGHPath(ghPath); err == nil {
			resolvedGHPath = resolved
		}
		if strings.Contains(message, "403") {
			return fmt.Errorf("login failed: GitHub rejected the local gh token while Octopool verified it (%s).\nLikely cause: the GitHub API rate limit for this token is exhausted, or the token needs re-auth.\nCheck reset: %s api rate_limit --jq '.resources.core'\nRetry after reset: octopool login --gh-path %s%s", message, resolvedGHPath, resolvedGHPath, requestID)
		}
		return fmt.Errorf("login failed: GitHub rejected the local gh token while Octopool verified it (%s).\nRefresh GitHub CLI auth: %s auth login\nThen retry: octopool login --gh-path %s%s", message, resolvedGHPath, resolvedGHPath, requestID)
	}
	return fmt.Errorf("login failed: %s: %s%s", response.Error.Code, message, requestID)
}

func validateLoginURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	if parsed.Scheme == "https" {
		return nil
	}
	if parsed.Scheme == "http" && isLoopbackHost(parsed.Hostname()) {
		return nil
	}
	if envDefault("OCTOPOOL_ALLOW_INSECURE_LOGIN", "") == "1" {
		return nil
	}
	return errors.New("login URL must use HTTPS; set OCTOPOOL_ALLOW_INSECURE_LOGIN=1 only for local development")
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func localGitHubToken(ctx context.Context, ghPath string) (string, error) {
	if token := strings.TrimSpace(os.Getenv("GH_TOKEN")); token != "" {
		return token, nil
	}
	if token := strings.TrimSpace(os.Getenv("GITHUB_TOKEN")); token != "" {
		return token, nil
	}
	path, err := resolveGHPath(ghPath)
	if err != nil {
		return "", err
	}
	child, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(child, path, "auth", "token")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("gh auth token failed: %w", err)
	}
	token := strings.TrimSpace(string(out))
	if token == "" {
		return "", errors.New("gh auth token returned empty output")
	}
	return token, nil
}

func resolveGHPath(configured string) (string, error) {
	if configured != "" && configured != "gh" {
		return configured, nil
	}
	self, _ := os.Executable()
	path, err := exec.LookPath("gh")
	if err == nil && !samePath(path, self) {
		return path, nil
	}
	for _, candidate := range []string{"/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"} {
		if !samePath(candidate, self) {
			if _, statErr := os.Stat(candidate); statErr == nil {
				return candidate, nil
			}
		}
	}
	return "", errors.New("real gh not found; set OCTOPOOL_GH_PATH or install GitHub CLI")
}

func samePath(left string, right string) bool {
	if left == "" || right == "" {
		return false
	}
	leftAbs, leftErr := filepath.Abs(left)
	rightAbs, rightErr := filepath.Abs(right)
	if leftErr != nil || rightErr != nil {
		return left == right
	}
	leftInfo, leftStat := os.Stat(leftAbs)
	rightInfo, rightStat := os.Stat(rightAbs)
	if leftStat == nil && rightStat == nil {
		return os.SameFile(leftInfo, rightInfo)
	}
	return leftAbs == rightAbs
}
