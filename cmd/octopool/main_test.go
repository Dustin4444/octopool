package main

import "testing"

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
