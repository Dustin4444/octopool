package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
