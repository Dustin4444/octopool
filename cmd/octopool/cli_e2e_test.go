package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCLIEndToEndRelayAndFallback(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and executes the CLI binary")
	}
	bin := buildCLIBinary(t)

	t.Run("relay response through octopool gh", func(t *testing.T) {
		server := cliRelayServer(t, func(w http.ResponseWriter, r *http.Request) {
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["path"] != "/repos/openclaw/octopool" {
				t.Fatalf("path = %v", body["path"])
			}
			writeCLIEnvelope(t, w, map[string]any{
				"name": "octopool", "full_name": "openclaw/octopool", "private": false,
			})
		})
		result := runCLI(t, bin, server.URL, nil, "gh", "repo", "view", "-R", "openclaw/octopool", "--json", "nameWithOwner")
		if result.err != nil || !strings.Contains(result.stdout, `"nameWithOwner":"openclaw/octopool"`) {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	t.Run("gh argv wrapper mode", func(t *testing.T) {
		server := cliRelayServer(t, func(w http.ResponseWriter, _ *http.Request) {
			writeCLIEnvelope(t, w, map[string]any{"name": "octopool", "full_name": "openclaw/octopool"})
		})
		wrapper := filepath.Join(t.TempDir(), executableName("gh"))
		binary, err := os.ReadFile(bin)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(wrapper, binary, 0o755); err != nil {
			t.Fatal(err)
		}
		result := runCLI(t, wrapper, server.URL, nil, "repo", "view", "-R", "openclaw/octopool", "--json", "nameWithOwner")
		if result.err != nil || !strings.Contains(result.stdout, "openclaw/octopool") {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	t.Run("unsupported command delegates to real gh", func(t *testing.T) {
		fake := fakeGH(t)
		result := runCLI(t, bin, "http://127.0.0.1:1", map[string]string{"OCTOPOOL_GH_PATH": fake}, "gh", "alias", "list")
		if result.err != nil || strings.TrimSpace(result.stdout) != "real-gh:alias list" {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	t.Run("server fallback delegates unless disabled", func(t *testing.T) {
		server := cliRelayServer(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusFailedDependency)
			_, _ = w.Write([]byte(`{"error":{"code":"fallback_local","message":"run locally","details":{"reason":"route_denied"}}}`))
		})
		fake := fakeGH(t)
		result := runCLI(t, bin, server.URL, map[string]string{"OCTOPOOL_GH_PATH": fake}, "gh", "repo", "view", "-R", "openclaw/octopool", "--json", "nameWithOwner")
		if result.err != nil || !strings.Contains(result.stdout, "real-gh:repo view") || !strings.Contains(result.stderr, "falling back") {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
		disabled := runCLI(t, bin, server.URL, map[string]string{
			"OCTOPOOL_GH_PATH": fake, "OCTOPOOL_NO_FALLBACK": "1",
		}, "gh", "repo", "view", "-R", "openclaw/octopool", "--json", "nameWithOwner")
		if disabled.err == nil || strings.Contains(disabled.stdout, "real-gh:") {
			t.Fatalf("err=%v stdout=%q stderr=%q", disabled.err, disabled.stdout, disabled.stderr)
		}
	})
}

func TestGHArgvNames(t *testing.T) {
	for _, name := range []string{"gh", "gh.exe", "octopool-gh", "OCTOPOOL-GH.EXE"} {
		if !isGHArgv(name) {
			t.Errorf("isGHArgv(%q) = false", name)
		}
	}
	if isGHArgv("octopool.exe") {
		t.Fatal("octopool executable must not enter gh wrapper mode")
	}
}

type cliResult struct {
	stdout string
	stderr string
	err    error
}

func buildCLIBinary(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), executableName("octopool"))
	cmd := exec.Command("go", "build", "-o", bin, ".")
	cmd.Dir = "."
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

func runCLI(t *testing.T, bin string, serverURL string, extra map[string]string, args ...string) cliResult {
	t.Helper()
	cmd := exec.Command(bin, args...)
	home := t.TempDir()
	env := append(os.Environ(),
		"HOME="+home,
		"OCTOPOOL_TOKEN=test-token",
		"OCTOPOOL_POOL=maintainers",
		"OCTOPOOL_URL="+serverURL,
	)
	for key, value := range extra {
		env = append(env, key+"="+value)
	}
	cmd.Env = env
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return cliResult{stdout: stdout.String(), stderr: stderr.String(), err: err}
}

func cliRelayServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/github/request" || r.Header.Get("Authorization") != "Bearer test-token" {
			t.Fatalf("request = %s auth=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	return server
}

func writeCLIEnvelope(t *testing.T, w http.ResponseWriter, body any) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(relayEnvelope{
		Status: 200, Body: raw, BodyEncoding: "json",
	}); err != nil {
		t.Fatal(err)
	}
}

func fakeGH(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), executableName("fake-gh"))
	content := "#!/bin/sh\nprintf 'real-gh:%s\\n' \"$*\"\n"
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is Unix-only")
	}
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func executableName(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}
