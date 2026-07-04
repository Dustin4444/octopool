package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	maxGHAuthTokenBytes         = 16 * 1024
	maxGitHubAuthProbeBodyBytes = 64 * 1024
)

type githubTokenIdentity struct {
	login     string
	coreReset time.Time
}

type githubTokenProbe func(context.Context, string, string) (githubTokenIdentity, error)

func isGHWithTokenLogin(args []string) bool {
	if len(args) < 2 || args[0] != "auth" || args[1] != "login" {
		return false
	}
	for _, arg := range args[2:] {
		if arg == "--with-token" {
			return true
		}
	}
	return false
}

func runGHWithTokenLogin(
	ctx context.Context,
	args []string,
	stdin io.Reader,
	stdout io.Writer,
	stderr io.Writer,
) error {
	return runGHWithTokenLoginProbe(ctx, args, stdin, stdout, stderr, probeGitHubToken)
}

func runGHWithTokenLoginProbe(
	ctx context.Context,
	args []string,
	stdin io.Reader,
	stdout io.Writer,
	stderr io.Writer,
	probe githubTokenProbe,
) error {
	rawToken, token, err := readGHAuthToken(stdin)
	if err != nil {
		return err
	}

	var loginOut bytes.Buffer
	var loginErr bytes.Buffer
	loginError := execRealGHWithStdinAndEnv(
		ctx,
		args,
		bytes.NewReader(rawToken),
		&loginOut,
		&loginErr,
		envWithoutGitHubTokens(),
	)
	if loginError == nil {
		_, _ = io.Copy(stdout, &loginOut)
		_, _ = io.Copy(stderr, &loginErr)
		return nil
	}
	if !isGHLoginRateLimitFailure(loginErr.String()) {
		return writeFailedAuthStatus(stdout, stderr, loginOut.Bytes(), loginErr.Bytes(), loginError)
	}

	identity, probeErr := probe(ctx, authStatusHostname(args), token)
	if probeErr != nil {
		return writeFailedAuthStatus(stdout, stderr, loginOut.Bytes(), loginErr.Bytes(), loginError)
	}

	_, _ = stdout.Write(loginOut.Bytes())
	if identity.coreReset.IsZero() {
		fmt.Fprintf(
			stderr,
			"octopool: token authenticates as %s via GitHub GraphQL, but gh cannot inspect scopes or store it while REST core quota is exhausted. Do not re-authenticate; retry this command after quota resets.\n",
			identity.login,
		)
	} else {
		fmt.Fprintf(
			stderr,
			"octopool: token authenticates as %s via GitHub GraphQL, but gh cannot inspect scopes or store it while REST core quota is exhausted until %s. Do not re-authenticate; retry this command after reset.\n",
			identity.login,
			identity.coreReset.UTC().Format(time.RFC3339),
		)
	}
	return loginError
}

func readGHAuthToken(stdin io.Reader) ([]byte, string, error) {
	raw, err := io.ReadAll(io.LimitReader(stdin, maxGHAuthTokenBytes+1))
	if err != nil {
		return nil, "", err
	}
	if len(raw) > maxGHAuthTokenBytes {
		return nil, "", fmt.Errorf("GitHub auth token input exceeds %d bytes", maxGHAuthTokenBytes)
	}
	token := strings.TrimSpace(string(raw))
	if token == "" || strings.ContainsAny(token, "\r\n") {
		return nil, "", errors.New("GitHub auth token input must contain exactly one non-empty line")
	}
	return raw, token, nil
}

func isGHLoginRateLimitFailure(stderr string) bool {
	lower := strings.ToLower(stderr)
	return strings.Contains(lower, "error validating token") &&
		strings.Contains(lower, "rate limit exceeded")
}

func probeGitHubToken(
	ctx context.Context,
	hostname string,
	token string,
) (githubTokenIdentity, error) {
	if hostname != "github.com" {
		return githubTokenIdentity{}, fmt.Errorf("GraphQL quota probe is unsupported for %s", hostname)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	query, err := json.Marshal(map[string]string{"query": authStatusViewerQuery})
	if err != nil {
		return githubTokenIdentity{}, err
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		"https://api.github.com/graphql",
		bytes.NewReader(query),
	)
	if err != nil {
		return githubTokenIdentity{}, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "octopool")
	response, err := client.Do(request)
	if err != nil {
		return githubTokenIdentity{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return githubTokenIdentity{}, fmt.Errorf("GitHub GraphQL returned %s", response.Status)
	}
	var result struct {
		Data struct {
			Viewer struct {
				Login string `json:"login"`
			} `json:"viewer"`
		} `json:"data"`
		Errors []json.RawMessage `json:"errors"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, maxGitHubAuthProbeBodyBytes)).Decode(&result); err != nil {
		return githubTokenIdentity{}, err
	}
	if result.Data.Viewer.Login == "" || len(result.Errors) > 0 {
		return githubTokenIdentity{}, errors.New("GitHub GraphQL did not return an authenticated viewer")
	}

	return githubTokenIdentity{
		login:     result.Data.Viewer.Login,
		coreReset: githubCoreReset(ctx, client, token),
	}, nil
}

func githubCoreReset(ctx context.Context, client *http.Client, token string) time.Time {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/", nil)
	if err != nil {
		return time.Time{}
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("User-Agent", "octopool")
	response, err := client.Do(request)
	if err != nil {
		return time.Time{}
	}
	defer response.Body.Close()
	if response.Header.Get("X-RateLimit-Remaining") != "0" {
		return time.Time{}
	}
	reset, err := strconv.ParseInt(response.Header.Get("X-RateLimit-Reset"), 10, 64)
	if err != nil {
		return time.Time{}
	}
	return time.Unix(reset, 0)
}
