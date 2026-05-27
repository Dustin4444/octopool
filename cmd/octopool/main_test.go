package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestVersionCommand(t *testing.T) {
	var stdout bytes.Buffer
	if err := run(t.Context(), []string{"version"}, &stdout, discardWriter{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "octopool ") {
		t.Fatalf("version output = %q", stdout.String())
	}
}

func TestVersionLineUsesInjectedMetadata(t *testing.T) {
	oldVersion, oldCommit, oldDate := version, commit, date
	t.Cleanup(func() {
		version, commit, date = oldVersion, oldCommit, oldDate
	})
	version, commit, date = "0.1.0", "abcdef0", "2026-05-27T00:00:00Z"

	if got := versionLine(); got != "octopool 0.1.0 (abcdef0, 2026-05-27T00:00:00Z)" {
		t.Fatalf("versionLine() = %q", got)
	}
}

func TestValidateAuthURLForRequestRejectsSavedTokenToDifferentURL(t *testing.T) {
	auth := authFile{URL: "https://octopool.dev", Token: "saved"}

	err := validateAuthURLForRequest(auth, "https://example.com", "OCTOPOOL_TOKEN")
	if err == nil {
		t.Fatal("expected URL override to require explicit token")
	}
}

func TestValidateAuthURLForRequestAllowsExplicitToken(t *testing.T) {
	t.Setenv("OCTOPOOL_TOKEN", "explicit")
	auth := authFile{URL: "https://octopool.dev", Token: "saved"}

	if err := validateAuthURLForRequest(auth, "https://example.com", "OCTOPOOL_TOKEN"); err != nil {
		t.Fatal(err)
	}
}

func TestValidateAuthURLForRequestNormalizesTrailingSlash(t *testing.T) {
	auth := authFile{URL: "https://octopool.dev/", Token: "saved"}

	if err := validateAuthURLForRequest(auth, "https://octopool.dev", "OCTOPOOL_TOKEN"); err != nil {
		t.Fatal(err)
	}
}
