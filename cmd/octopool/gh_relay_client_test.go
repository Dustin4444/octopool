package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWriteGHBodyAllowsNullTextBody(t *testing.T) {
	envelope := relayEnvelope{Status: 304, Body: []byte("null"), BodyEncoding: "text"}
	if err := writeGHBody(t.Context(), discardWriter{}, envelope, ""); err != nil {
		t.Fatal(err)
	}
}

func TestParseLocalFallback(t *testing.T) {
	err, ok := parseLocalFallback([]byte(`{"error":{"code":"fallback_local","message":"Run locally","details":{"reason":"route_denied"}}}`))
	if !ok {
		t.Fatal("expected fallback")
	}
	if err.Reason != "route_denied" {
		t.Fatalf("reason = %q", err.Reason)
	}
}

func TestGHRelayClientInvalidAuthUsesLocalFallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"code":"invalid_auth","message":"Invalid caller token"}}`))
	}))
	t.Cleanup(server.Close)

	client := ghRelayClient{token: "stale", baseURL: server.URL, pool: "maintainers"}
	_, err := client.do(t.Context(), ghAPIRequest{method: "GET", path: "/repos/openclaw/openclaw"})
	if !isLocalFallback(err) {
		t.Fatalf("expected local fallback, got %v", err)
	}
}

func TestShouldRunRealGH(t *testing.T) {
	if !shouldRunRealGH(localFallbackError{Reason: "route_denied"}) {
		t.Fatal("fallback_local should run real gh")
	}
	if !shouldRunRealGH(errOctopoolNotLoggedIn) {
		t.Fatal("missing octopool login should run real gh")
	}
	if shouldRunRealGH(assertAnError{}) {
		t.Fatal("ordinary errors should not run real gh")
	}
}

func TestNewGHRelayClientMissingLoginUsesFallbackSentinel(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("OCTOPOOL_TOKEN", "")
	_, err := newGHRelayClient()
	if !errors.Is(err, errOctopoolNotLoggedIn) {
		t.Fatalf("err = %v", err)
	}
}

type assertAnError struct{}

func (assertAnError) Error() string {
	return "boom"
}

type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) {
	return len(p), nil
}
