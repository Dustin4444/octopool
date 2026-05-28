package main

import (
	"strings"
	"testing"
)

func TestValidateLoginURLRequiresHTTPS(t *testing.T) {
	if err := validateLoginURL("https://octopool.dev"); err != nil {
		t.Fatal(err)
	}
	if err := validateLoginURL("http://127.0.0.1:8787"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OCTOPOOL_ALLOW_INSECURE_LOGIN", "")
	if err := validateLoginURL("http://octopool.dev"); err == nil {
		t.Fatal("expected insecure login URL to fail")
	}
}

func TestFormatLoginFailureExplainsGitHub403(t *testing.T) {
	t.Setenv("TZ", "UTC")
	err := formatLoginFailure(401, []byte(`{"error":{"code":"github_auth_failed","message":"GitHub token check failed with 403","request_id":"req-123","details":{"github_rate_limit_reset":"1779928316","github_rate_limit_remaining":"0","github_rate_limit_resource":"core"}}}`), "/bin/gh")
	if err == nil {
		t.Fatal("expected error")
	}
	got := err.Error()
	for _, want := range []string{
		"GitHub rejected the local gh token",
		"rate limit",
		"GitHub reset: Thu, 28 May 2026 00:31:56 UTC",
		"remaining: 0",
		"resource: core",
		"/bin/gh api rate_limit",
		"req-123",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in error:\n%s", want, got)
		}
	}
}

func TestFormatLoginFailureExplainsGitHub429(t *testing.T) {
	t.Setenv("TZ", "UTC")
	err := formatLoginFailure(401, []byte(`{"error":{"code":"github_auth_failed","message":"GitHub token check failed with 429","details":{"github_rate_limit_reset":"1779928316","github_retry_after":"60"}}}`), "/bin/gh")
	if err == nil {
		t.Fatal("expected error")
	}
	got := err.Error()
	for _, want := range []string{
		"rate limit",
		"GitHub reset: Thu, 28 May 2026 00:31:56 UTC",
		"retry-after: 60s",
		"Retry after reset",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in error:\n%s", want, got)
		}
	}
}

func TestFormatLoginFailureDoesNotTreatResetHeaderAsRateLimit(t *testing.T) {
	t.Setenv("TZ", "UTC")
	err := formatLoginFailure(401, []byte(`{"error":{"code":"github_auth_failed","message":"GitHub token check failed with 401","details":{"github_rate_limit_reset":"1779928316","github_rate_limit_remaining":"4999"}}}`), "/bin/gh")
	if err == nil {
		t.Fatal("expected error")
	}
	got := err.Error()
	if !strings.Contains(got, "Refresh GitHub CLI auth") {
		t.Fatalf("expected re-auth guidance:\n%s", got)
	}
	if strings.Contains(got, "Retry after reset") {
		t.Fatalf("did not expect rate-limit guidance:\n%s", got)
	}
}
