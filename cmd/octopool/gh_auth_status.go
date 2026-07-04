package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
)

const authStatusViewerQuery = "query OctopoolAuthStatus { viewer { login } }"

func isGHAuthStatus(args []string) bool {
	return len(args) >= 2 && args[0] == "auth" && args[1] == "status"
}

func isScopedGHAuthStatus(args []string) bool {
	if !isGHAuthStatus(args) {
		return false
	}
	hasActive := false
	hasHostname := false
	for index := 2; index < len(args); index++ {
		switch args[index] {
		case "--active", "-a":
			hasActive = true
		case "--hostname", "-h":
			index++
			if index >= len(args) || args[index] == "" {
				return false
			}
			hasHostname = true
		default:
			hostname, ok := strings.CutPrefix(args[index], "--hostname=")
			if !ok || hostname == "" {
				return false
			}
			hasHostname = true
		}
	}
	return hasActive && hasHostname
}

func runGHAuthStatus(
	ctx context.Context,
	args []string,
	stdout io.Writer,
	stderr io.Writer,
) error {
	var statusOut bytes.Buffer
	var statusErr bytes.Buffer
	statusError := execRealGH(ctx, args, &statusOut, &statusErr)
	if statusError == nil {
		_, _ = io.Copy(stdout, &statusOut)
		_, _ = io.Copy(stderr, &statusErr)
		return nil
	}

	// gh resolves the login through GraphQL, then asks the REST root only for token
	// scopes. A depleted REST bucket makes that second probe report a valid token as
	// invalid, which sends users through an OAuth flow that cannot restore quota.
	if !invalidTokenStatus(statusOut.String(), statusErr.String()) {
		return writeFailedAuthStatus(stdout, stderr, statusOut.Bytes(), statusErr.Bytes(), statusError)
	}

	hostname := authStatusHostname(args)
	login, err := graphqlViewerLogin(ctx, hostname)
	if err != nil {
		return writeFailedAuthStatus(stdout, stderr, statusOut.Bytes(), statusErr.Bytes(), statusError)
	}
	if !isScopedGHAuthStatus(args) {
		_ = writeFailedAuthStatus(stdout, stderr, statusOut.Bytes(), statusErr.Bytes(), statusError)
		fmt.Fprintf(
			stderr,
			"octopool: active %s token still authenticates as %s via GraphQL; do not re-authenticate for this REST scope-probe failure\n",
			hostname,
			login,
		)
		return statusError
	}

	fmt.Fprintf(stdout, "%s\n", hostname)
	fmt.Fprintf(
		stdout,
		"  ✓ Logged in to %s account %s (%s)\n",
		hostname,
		login,
		activeGitHubTokenSource(),
	)
	fmt.Fprintln(stdout, "  - Active account: true")
	fmt.Fprintln(stdout, "  - Authentication verified via GitHub GraphQL")
	fmt.Fprintln(stdout, "  - REST scope check unavailable; do not re-authenticate")
	return nil
}

func invalidTokenStatus(stdout string, stderr string) bool {
	output := stdout + "\n" + stderr
	return strings.Contains(output, "The token in ") && strings.Contains(output, " is invalid.")
}

func graphqlViewerLogin(ctx context.Context, hostname string) (string, error) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	err := execRealGH(
		ctx,
		[]string{
			"api",
			"graphql",
			"--hostname",
			hostname,
			"-f",
			"query=" + authStatusViewerQuery,
			"--jq",
			".data.viewer.login",
		},
		&stdout,
		&stderr,
	)
	if err != nil {
		return "", err
	}
	login := strings.TrimSpace(stdout.String())
	if login == "" || strings.ContainsAny(login, "\r\n") {
		return "", fmt.Errorf("GitHub GraphQL viewer returned an invalid login")
	}
	return login, nil
}

func authStatusHostname(args []string) string {
	for index := 2; index < len(args); index++ {
		switch args[index] {
		case "--hostname", "-h":
			if index+1 < len(args) && args[index+1] != "" {
				return args[index+1]
			}
		default:
			if hostname, ok := strings.CutPrefix(args[index], "--hostname="); ok && hostname != "" {
				return hostname
			}
		}
	}
	return "github.com"
}

func activeGitHubTokenSource() string {
	for _, name := range []string{
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"GH_ENTERPRISE_TOKEN",
		"GITHUB_ENTERPRISE_TOKEN",
	} {
		if os.Getenv(name) != "" {
			return name
		}
	}
	return "keyring"
}

func writeFailedAuthStatus(
	stdout io.Writer,
	stderr io.Writer,
	statusOut []byte,
	statusErr []byte,
	err error,
) error {
	_, _ = stdout.Write(statusOut)
	_, _ = stderr.Write(statusErr)
	return err
}
