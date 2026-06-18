package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"time"
)

type localFallbackError struct {
	Reason string
}

func (err localFallbackError) Error() string {
	if err.Reason == "" {
		return "octopool requested local gh fallback"
	}
	return "octopool requested local gh fallback: " + err.Reason
}

func isLocalFallback(err error) bool {
	var fallback localFallbackError
	return errors.As(err, &fallback)
}

func shouldRunRealGH(err error) bool {
	return isLocalFallback(err) || errors.Is(err, errOctopoolNotLoggedIn)
}

func parseLocalFallback(out []byte) (localFallbackError, bool) {
	var response apiErrorResponse
	if err := json.Unmarshal(out, &response); err != nil {
		return localFallbackError{}, false
	}
	if response.Error.Code != "fallback_local" {
		return localFallbackError{}, false
	}
	reason := response.Error.Details.FallbackReason
	if reason == "" {
		reason = response.Error.Message
	}
	return localFallbackError{Reason: reason}, true
}

func parseAuthFallback(out []byte) (localFallbackError, bool) {
	var response apiErrorResponse
	if err := json.Unmarshal(out, &response); err != nil {
		return localFallbackError{}, false
	}
	switch response.Error.Code {
	case "missing_auth", "invalid_auth":
		return localFallbackError{Reason: "octopool auth unavailable"}, true
	default:
		return localFallbackError{}, false
	}
}

func execRealGHAfterLocalFallback(
	ctx context.Context,
	args []string,
	stdout io.Writer,
	stderr io.Writer,
	reason error,
) error {
	if envDefault("OCTOPOOL_NO_FALLBACK", "") != "" {
		return reason
	}
	if !errors.Is(reason, errOctopoolNotLoggedIn) {
		fmt.Fprintf(stderr, "octopool: %v; falling back to real gh\n", reason)
	}
	return execRealGH(ctx, args, stdout, stderr)
}

func runJQ(ctx context.Context, stdout io.Writer, input []byte, expr string) error {
	child, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(child, "jq", "-r", expr)
	cmd.Stdin = bytes.NewReader(input)
	cmd.Stdout = stdout
	cmd.Stderr = io.Discard
	return cmd.Run()
}

func jqAvailable() bool {
	_, err := exec.LookPath("jq")
	return err == nil
}

func execRealGH(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) error {
	path, err := resolveGHPath(envDefault("OCTOPOOL_GH_PATH", "gh"))
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitCodeError{Code: exitErr.ExitCode()}
		}
		return err
	}
	return nil
}
