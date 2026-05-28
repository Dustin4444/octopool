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
	err := formatLoginFailure(401, []byte(`{"error":{"code":"github_auth_failed","message":"GitHub token check failed with 403","request_id":"req-123"}}`), "/bin/gh")
	if err == nil {
		t.Fatal("expected error")
	}
	got := err.Error()
	for _, want := range []string{
		"GitHub rejected the local gh token",
		"rate limit",
		"/bin/gh api rate_limit",
		"req-123",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in error:\n%s", want, got)
		}
	}
}
