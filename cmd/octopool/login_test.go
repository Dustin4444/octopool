package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
	err := formatLoginFailure(401, []byte(`{"error":{"code":"github_auth_failed","message":"GitHub token check failed with 403","request_id":"req-123","details":{"github_rate_limit_reset":"1779928316","github_rate_limit_remaining":"0","github_rate_limit_resource":"core"}}}`), "/bin/gh", "https://octopool.dev", "core")
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
	err := formatLoginFailure(401, []byte(`{"error":{"code":"github_auth_failed","message":"GitHub token check failed with 429","details":{"github_rate_limit_reset":"1779928316","github_retry_after":"60"}}}`), "/bin/gh", "https://octopool.dev", "core")
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
	err := formatLoginFailure(401, []byte(`{"error":{"code":"github_auth_failed","message":"GitHub token check failed with 401","details":{"github_rate_limit_reset":"1779928316","github_rate_limit_remaining":"4999"}}}`), "/bin/gh", "https://octopool.dev", "core")
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

func TestLocalGitHubAuthErrorGivesReauthenticationCommands(t *testing.T) {
	err := localGitHubAuthError("/opt/homebrew/opt/gh/bin/gh", errors.New("exit status 1"))
	got := err.Error()
	for _, want := range []string{
		"gh auth token failed: exit status 1",
		"/opt/homebrew/opt/gh/bin/gh auth login --hostname github.com --web",
		"octopool login --gh-path /opt/homebrew/opt/gh/bin/gh",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in error:\n%s", want, got)
		}
	}
}

func TestFormatLoginFailureExplainsCallerProvisioning(t *testing.T) {
	err := formatLoginFailure(403, []byte(`{"error":{"code":"caller_not_provisioned","message":"Caller is not provisioned for this pool","request_id":"req-123"}}`), "/bin/gh", "https://octopool.dev", "maintainers")
	if err == nil {
		t.Fatal("expected error")
	}
	got := err.Error()
	for _, want := range []string{
		`not provisioned for Octopool pool "maintainers"`,
		"octopool admin caller --url 'https://octopool.dev' --pool 'maintainers' --github-login your-github-login",
		"Then retry: octopool login 'https://octopool.dev'",
		"req-123",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in error:\n%s", want, got)
		}
	}
}

func TestFormatLoginFailureQuotesProvisioningCommandArguments(t *testing.T) {
	err := formatLoginFailure(403, []byte(`{"error":{"code":"caller_not_provisioned","message":"Caller is not provisioned for this pool"}}`), "/bin/gh", "https://octopool.dev/path;echo pwned", "maintainers'$(touch /tmp/pwned)")
	if err == nil {
		t.Fatal("expected error")
	}
	got := err.Error()
	for _, want := range []string{
		"--url 'https://octopool.dev/path;echo pwned'",
		"--pool 'maintainers'\"'\"'$(touch /tmp/pwned)'",
		"Then retry: octopool login 'https://octopool.dev/path;echo pwned'",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in error:\n%s", want, got)
		}
	}
}

func TestLoginAcceptsPositionalServerAndStoresDiscoveredAuth(t *testing.T) {
	t.Setenv("GH_TOKEN", "gh_test")
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/octopool":
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"service":"octopool","version":1,"api_base":"` + server.URL + `","app_base":"` + server.URL + `","default_pool":"core","allowed_org":"acme","auth":{"cli_github_token":true,"web_login":true}}`))
		case "/v1/login/github-cli":
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["github_token"] != "gh_test" || body["pool"] != "core" {
				t.Fatalf("login body = %#v", body)
			}
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"caller":{"github_login":"alice","pool":"core"},"token":"op_test"}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	var stdout bytes.Buffer
	if err := runLogin(t.Context(), []string{server.URL}, &stdout); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "logged in to "+server.URL+" as alice for pool core") {
		t.Fatalf("stdout = %q", stdout.String())
	}
	authFilePath, err := authPath()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(authFilePath)
	if err != nil {
		t.Fatal(err)
	}
	var auth authFile
	if err := json.Unmarshal(data, &auth); err != nil {
		t.Fatal(err)
	}
	if auth.URL != server.URL || auth.Pool != "core" || auth.Token != "op_test" || auth.Login != "alice" {
		t.Fatalf("auth = %#v", auth)
	}
}

func TestLoginServerArgumentRejectsDisagreement(t *testing.T) {
	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	server := fs.String("server", "", "server")
	if err := fs.Parse([]string{"--server", "https://flag.example", "https://pos.example"}); err != nil {
		t.Fatal(err)
	}
	if _, err := loginServerArgument(fs, "", *server); err == nil {
		t.Fatal("expected disagreement error")
	}
}

func TestNormalizeLoginArgsAllowsFlagsAfterServer(t *testing.T) {
	got := normalizeLoginArgs([]string{
		"https://octopool.example.com",
		"--pool",
		"core",
		"--trust-discovery-redirect",
	})
	want := []string{
		"--pool",
		"core",
		"--trust-discovery-redirect",
		"https://octopool.example.com",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("normalizeLoginArgs() = %#v", got)
	}
}

func TestResolveGHPathSkipsOctopoolWrapper(t *testing.T) {
	dir := t.TempDir()
	wrapper := filepath.Join(dir, "gh")
	realDir := filepath.Join(dir, "real")
	if err := os.Mkdir(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	realGH := filepath.Join(realDir, "gh")
	self := filepath.Join(dir, "octopool")
	if err := os.WriteFile(wrapper, []byte("#!/bin/sh\nexec octopool gh \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(realGH, []byte("#!/bin/sh\necho gh version\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(self, []byte("octopool"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := resolveGHPathFrom(
		"gh",
		self,
		ghPathCandidates(dir+string(os.PathListSeparator)+realDir, nil),
	)
	if err != nil {
		t.Fatal(err)
	}
	if !samePath(got, realGH) {
		t.Fatalf("resolveGHPathFrom() = %q, want %q", got, realGH)
	}
}

func TestResolveGHPathSkipsOctopoolSymlink(t *testing.T) {
	dir := t.TempDir()
	wrapperDir := filepath.Join(dir, "wrapper")
	realDir := filepath.Join(dir, "real")
	if err := os.Mkdir(wrapperDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	octopoolBinary := filepath.Join(dir, "octopool")
	if err := os.WriteFile(octopoolBinary, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(octopoolBinary, filepath.Join(wrapperDir, "gh")); err != nil {
		t.Fatal(err)
	}
	realGH := filepath.Join(realDir, "gh")
	if err := os.WriteFile(realGH, []byte("#!/bin/sh\necho gh version\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := resolveGHPathFrom(
		"gh",
		filepath.Join(dir, "current-octopool"),
		ghPathCandidates(wrapperDir+string(os.PathListSeparator)+realDir, nil),
	)
	if err != nil {
		t.Fatal(err)
	}
	if got != realGH {
		t.Fatalf("resolveGHPathFrom() = %q, want %q", got, realGH)
	}
}

func TestResolveGHPathSkipsGitcrawlShim(t *testing.T) {
	dir := t.TempDir()
	shimDir := filepath.Join(dir, "shim")
	realDir := filepath.Join(dir, "real")
	if err := os.Mkdir(shimDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	gitcrawlBinary := filepath.Join(dir, "gitcrawl-gh")
	if err := os.WriteFile(gitcrawlBinary, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(gitcrawlBinary, filepath.Join(shimDir, "gh")); err != nil {
		t.Fatal(err)
	}
	realGH := filepath.Join(realDir, "gh")
	if err := os.WriteFile(realGH, []byte("#!/bin/sh\necho gh version\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := resolveGHPathFrom(
		"gh",
		filepath.Join(dir, "octopool"),
		ghPathCandidates(shimDir+string(os.PathListSeparator)+realDir, nil),
	)
	if err != nil {
		t.Fatal(err)
	}
	if got != realGH {
		t.Fatalf("resolveGHPathFrom() = %q, want %q", got, realGH)
	}
}

func TestResolveGHPathSkipsCopiedGoShim(t *testing.T) {
	dir := t.TempDir()
	shimDir := filepath.Join(dir, "shim")
	realDir := filepath.Join(dir, "real")
	if err := os.Mkdir(shimDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(shimDir, "gh.exe")
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(shim, data, 0o755); err != nil {
		t.Fatal(err)
	}
	realGH := filepath.Join(realDir, "gh.exe")
	if err := os.WriteFile(realGH, []byte("real gh"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := resolveGHPathFrom(
		"gh",
		filepath.Join(dir, "octopool.exe"),
		[]string{shim, realGH},
	)
	if err != nil {
		t.Fatal(err)
	}
	if got != realGH {
		t.Fatalf("resolveGHPathFrom() = %q, want %q", got, realGH)
	}
}

func TestResolveGHPathRejectsExplicitShim(t *testing.T) {
	dir := t.TempDir()
	gitcrawlBinary := filepath.Join(dir, "gitcrawl-gh")
	if err := os.WriteFile(gitcrawlBinary, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(dir, "gh")
	if err := os.Symlink(gitcrawlBinary, shim); err != nil {
		t.Fatal(err)
	}

	_, err := resolveGHPathFrom(shim, filepath.Join(dir, "octopool"), nil)
	if err == nil || !strings.Contains(err.Error(), "does not point to the real GitHub CLI") {
		t.Fatalf("resolveGHPathFrom() error = %v", err)
	}
}

func TestResolveGHPathAcceptsExplicitRelativePath(t *testing.T) {
	dir := t.TempDir()
	toolsDir := filepath.Join(dir, "tools")
	if err := os.Mkdir(toolsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	realGH := filepath.Join(toolsDir, "gh")
	if err := os.WriteFile(realGH, []byte("#!/bin/sh\necho gh version\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	previousDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(previousDir); err != nil {
			t.Errorf("restore working directory: %v", err)
		}
	})

	got, err := resolveGHPathFrom(filepath.Join(".", "tools", "gh"), filepath.Join(dir, "octopool"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !samePath(got, realGH) {
		t.Fatalf("resolveGHPathFrom() = %q, want %q", got, realGH)
	}
}

func TestResolveGHPathAcceptsExplicitCommandName(t *testing.T) {
	dir := t.TempDir()
	realGH := filepath.Join(dir, "custom-gh")
	if err := os.WriteFile(realGH, []byte("#!/bin/sh\necho gh version\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)

	got, err := resolveGHPathFrom("custom-gh", filepath.Join(dir, "octopool"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got != realGH {
		t.Fatalf("resolveGHPathFrom() = %q, want %q", got, realGH)
	}
}

func TestResolveGHPathSkipsInvalidCandidates(t *testing.T) {
	dir := t.TempDir()
	nonExecutableDir := filepath.Join(dir, "nonexec")
	realDir := filepath.Join(dir, "real")
	if err := os.Mkdir(nonExecutableDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nonExecutableDir, "gh"), []byte("#!/bin/sh\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	realGH := filepath.Join(realDir, "gh")
	if err := os.WriteFile(realGH, []byte("#!/bin/sh\necho gh version\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	candidates := ghPathCandidates(
		"relative-bin"+string(os.PathListSeparator)+nonExecutableDir+string(os.PathListSeparator)+realDir,
		nil,
	)
	for _, candidate := range candidates {
		if !filepath.IsAbs(candidate) {
			t.Fatalf("relative candidate was included: %q", candidate)
		}
	}
	got, err := resolveGHPathFrom("gh", filepath.Join(dir, "octopool"), candidates)
	if err != nil {
		t.Fatal(err)
	}
	if got != realGH {
		t.Fatalf("resolveGHPathFrom() = %q, want %q", got, realGH)
	}
}

func TestGHPathCandidatesIncludesWindowsExtensions(t *testing.T) {
	names := ghExecutableNames("windows", ".COM;.EXE;.BAT;.CMD")
	for _, name := range names {
		if name == "gh.exe" {
			return
		}
	}
	t.Fatalf("expected gh.exe in names %#v", names)
}
