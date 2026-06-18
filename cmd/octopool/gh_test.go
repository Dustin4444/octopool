package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseGHAPIArgs(t *testing.T) {
	request, fallback, err := parseGHAPIArgs([]string{
		"repos/openclaw/openclaw/pulls/85341?per_page=100",
		"--jq",
		".number",
		"-H",
		"Accept: application/vnd.github+json",
	})
	if err != nil {
		t.Fatal(err)
	}
	if fallback {
		t.Fatal("unexpected fallback")
	}
	if request.path != "/repos/openclaw/openclaw/pulls/85341" {
		t.Fatalf("path = %q", request.path)
	}
	if request.query["per_page"] != "100" {
		t.Fatalf("query = %#v", request.query)
	}
	if request.headers["accept"] != "application/vnd.github+json" {
		t.Fatalf("headers = %#v", request.headers)
	}
	if request.jq != ".number" {
		t.Fatalf("jq = %q", request.jq)
	}
}

func TestParseGHAPIArgsDecodesQueryOnce(t *testing.T) {
	request, fallback, err := parseGHAPIArgs([]string{
		"/repos/openclaw/openclaw/actions/runs?branch=feature%2Ffoo&label=a&label=b",
	})
	if err != nil {
		t.Fatal(err)
	}
	if fallback {
		t.Fatal("unexpected fallback")
	}
	if request.query["branch"] != "feature/foo" {
		t.Fatalf("query = %#v", request.query)
	}
	labels, ok := request.query["label"].([]string)
	if !ok || len(labels) != 2 || labels[0] != "a" || labels[1] != "b" {
		t.Fatalf("query = %#v", request.query)
	}
}

func TestParseGHAPIArgsFallsBackForSensitiveHeaders(t *testing.T) {
	_, fallback, err := parseGHAPIArgs([]string{
		"/user",
		"-H",
		"Authorization: Bearer secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !fallback {
		t.Fatal("expected fallback")
	}
}

func TestSafeRelayRequest(t *testing.T) {
	request, fallback, err := parseGHAPIArgs([]string{"/repos/openclaw/openclaw/pulls/1"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if !safeRelayRequest(request) {
		t.Fatal("expected supported PR path")
	}

	for _, path := range []string{
		"/users/openperf",
		"/users/dependabot%5Bbot%5D",
		"/users/dependabot[bot]",
		"/repos/openclaw/octopool",
		"/repos/openclaw/octopool/pulls?state=open",
		"/repos/openclaw/octopool/pulls/1/commits",
		"/repos/openclaw/octopool/issues?state=open",
		"/repos/openclaw/octopool/issues/1/events",
		"/repos/openclaw/octopool/contents/README.md?ref=main",
		"/repos/openclaw/octopool/compare/main...feature",
		"/repos/openclaw/octopool/actions/workflows/ci.yml",
		"/repos/openclaw/octopool/actions/workflows/ci.yml/runs",
		"/repos/openclaw/octopool/releases",
		"/repos/openclaw/octopool/releases/latest",
		"/repos/openclaw/octopool/releases/tags/v0.2.5",
		"/repos/openclaw/octopool/releases/123",
	} {
		request, fallback, err = parseGHAPIArgs([]string{path})
		if err != nil || fallback {
			t.Fatalf("parse %s fallback=%v err=%v", path, fallback, err)
		}
		if !safeRelayRequest(request) {
			t.Fatalf("expected supported path %s", path)
		}
	}

	request, fallback, err = parseGHAPIArgs([]string{"/search/issues?q=repo:openclaw/openclaw"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if !safeRelayRequest(request) {
		t.Fatal("search read can ask octopool for a policy decision")
	}

	request, fallback, err = parseGHAPIArgs([]string{"/search/issues"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if !safeRelayRequest(request) {
		t.Fatal("queryless unknown read can ask octopool for a fallback decision")
	}

	request, fallback, err = parseGHAPIArgs([]string{"/gitignore/templates/C%2B%2B"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if !safeRelayRequest(request) {
		t.Fatal("encoded gitignore template names can ask octopool for a policy decision")
	}

	request, fallback, err = parseGHAPIArgs([]string{"/search/repositories?q=octopool+relay"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if !safeRelayRequest(request) {
		t.Fatal("plain repository search can ask octopool for a policy decision")
	}

	request, fallback, err = parseGHAPIArgs([]string{"/search/repositories?q=language:go"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if safeRelayRequest(request) {
		t.Fatal("qualified repository search should stay local")
	}

	request, fallback, err = parseGHAPIArgs([]string{"/repos/cli/cli/pulls/1"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if !safeRelayRequest(request) {
		t.Fatal("owner policy should be decided by octopool")
	}

	request, fallback, err = parseGHAPIArgs([]string{"/repos/openclaw/openclaw/pulls/1?access_token=x"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if safeRelayRequest(request) {
		t.Fatal("token query should fall back")
	}

	request, fallback, err = parseGHAPIArgs([]string{"/repos/openclaw/openclaw/pulls/1?client_secret=x"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if safeRelayRequest(request) {
		t.Fatal("secret query should fall back")
	}

	request, fallback, err = parseGHAPIArgs([]string{"/repos/openclaw/openclaw/contents/../secret?ref=main"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if safeRelayRequest(request) {
		t.Fatal("canonicalizing path should stay local")
	}
}

func TestTopLevelRepoNumber(t *testing.T) {
	opts := ghTopOptions{repo: "openclaw/openclaw", positionals: []string{"85341"}}
	repo, number, ok := repoNumber(opts)
	if !ok || repo != "openclaw/openclaw" || number != "85341" {
		t.Fatalf("repoNumber = %q %q %v", repo, number, ok)
	}

	opts = ghTopOptions{positionals: []string{"https://github.com/openclaw/openclaw/pull/85341"}}
	repo, number, ok = repoNumber(opts)
	if !ok || repo != "openclaw/openclaw" || number != "85341" {
		t.Fatalf("repoNumber URL = %q %q %v", repo, number, ok)
	}

	opts = ghTopOptions{repo: "cli/cli", positionals: []string{"1"}}
	repo, number, ok = repoNumber(opts)
	if !ok || repo != "cli/cli" || number != "1" {
		t.Fatalf("repoNumber outside default owner = %q %q %v", repo, number, ok)
	}

	opts = ghTopOptions{repo: "openclaw", positionals: []string{"1"}}
	if _, _, ok = repoNumber(opts); ok {
		t.Fatal("malformed explicit repo should fall back")
	}
}

func TestParseGHTopOptions(t *testing.T) {
	opts, fallback, err := parseGHTopOptions([]string{
		"-R", "openclaw/openclaw",
		"--json", "number,title,url",
		"--jq", ".number",
		"--limit", "50",
		"--state=open",
		"--label", "bug",
		"85341",
	})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if opts.repo != "openclaw/openclaw" || opts.limit != 50 || opts.state != "open" {
		t.Fatalf("opts = %#v", opts)
	}
	if len(opts.json) != 3 || opts.json[2] != "url" || opts.jq != ".number" {
		t.Fatalf("opts = %#v", opts)
	}
	if len(opts.labels) != 1 || opts.labels[0] != "bug" {
		t.Fatalf("opts = %#v", opts)
	}
	if len(opts.positionals) != 1 || opts.positionals[0] != "85341" {
		t.Fatalf("opts = %#v", opts)
	}
}

func TestParseGHTopOptionsRejectsInvalidLimit(t *testing.T) {
	_, fallback, err := parseGHTopOptions([]string{"--limit", "nope"})
	if err == nil || fallback {
		t.Fatalf("fallback=%v err=%v", fallback, err)
	}
}

func TestRunGHReleaseListRelays(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/repos/openclaw/octopool/releases" {
			t.Fatalf("path = %v", body["path"])
		}
		query, ok := body["query"].(map[string]any)
		if !ok || query["per_page"] != "10" {
			t.Fatalf("query = %#v", body["query"])
		}
		return []map[string]any{{
			"tag_name": "v0.2.5",
			"name":     "0.2.5",
			"html_url": "https://github.com/openclaw/octopool/releases/tag/v0.2.5",
		}}
	})
	var out bytes.Buffer
	handled, err := runGHRelease(t.Context(), []string{
		"list",
		"-R", "openclaw/octopool",
		"--limit", "10",
		"--json", "tagName,name,url",
	}, &out)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if got := out.String(); !strings.Contains(got, `"tagName":"v0.2.5"`) || !strings.Contains(got, `"url":"https://github.com/openclaw/octopool/releases/tag/v0.2.5"`) {
		t.Fatalf("out = %s", got)
	}
}

func TestRunGHRunViewComposesJobs(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/actions/runs/27398328238":
			headers, ok := body["headers"].(map[string]any)
			if !ok || headers["x-octopool-public-shape"] != "actions-summary-v1" {
				t.Fatalf("run headers = %#v", body["headers"])
			}
			return map[string]any{
				"id":         27398328238,
				"status":     "completed",
				"conclusion": "success",
				"head_sha":   "20d9295e7d6258943d6682fe5532ba3f0caedd29",
			}
		case "/repos/openclaw/octopool/actions/runs/27398328238/jobs":
			headers, ok := body["headers"].(map[string]any)
			if !ok || headers["x-octopool-public-shape"] != "actions-jobs-v1" {
				t.Fatalf("jobs headers = %#v", body["headers"])
			}
			query, ok := body["query"].(map[string]any)
			if !ok || query["per_page"] != "100" {
				t.Fatalf("jobs query = %#v", body["query"])
			}
			return map[string]any{
				"total_count": 1,
				"jobs": []map[string]any{{
					"id":           80970314592,
					"name":         "Check",
					"status":       "completed",
					"conclusion":   "success",
					"started_at":   "2026-06-12T06:15:20Z",
					"completed_at": "2026-06-12T06:17:55Z",
					"html_url":     "https://github.com/openclaw/octopool/actions/runs/27398328238/job/80970314592",
					"steps": []map[string]any{{
						"name":         "Check out",
						"number":       2,
						"status":       "completed",
						"conclusion":   "success",
						"started_at":   "2026-06-12T06:15:23Z",
						"completed_at": "2026-06-12T06:15:26Z",
					}},
				}},
			}
		default:
			t.Fatalf("unexpected path = %v", body["path"])
			return nil
		}
	})
	var out bytes.Buffer
	handled, err := runGHRun(t.Context(), []string{
		"view",
		"27398328238",
		"-R", "openclaw/octopool",
		"--json", "databaseId,status,conclusion,headSha,jobs",
	}, &out)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	var got map[string]any
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	jobs, ok := got["jobs"].([]any)
	if !ok || len(jobs) != 1 {
		t.Fatalf("jobs = %#v", got["jobs"])
	}
	job := jobs[0].(map[string]any)
	if job["databaseId"] != float64(80970314592) || job["startedAt"] != "2026-06-12T06:15:20Z" {
		t.Fatalf("job = %#v", job)
	}
	steps := job["steps"].([]any)
	step := steps[0].(map[string]any)
	if step["completedAt"] != "2026-06-12T06:15:26Z" {
		t.Fatalf("step = %#v", step)
	}
}

func TestRunGHRunListDoesNotAcceptJobs(t *testing.T) {
	var out bytes.Buffer
	handled, err := runGHRun(t.Context(), []string{
		"list",
		"-R", "openclaw/octopool",
		"--json", "jobs",
	}, &out)
	if err != nil || handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}

func TestRunGHRunListDoesNotAcceptID(t *testing.T) {
	var out bytes.Buffer
	handled, err := runGHRun(t.Context(), []string{
		"list",
		"-R", "openclaw/octopool",
		"--json", "id",
	}, &out)
	if err != nil || handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}

func TestRunGHRunListMapsDisplayTitle(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		return map[string]any{"workflow_runs": []map[string]any{{
			"id":            27398328238,
			"display_title": "feat: preserve anonymous quota",
			"run_number":    80,
		}}}
	})
	var out bytes.Buffer
	handled, err := runGHRun(t.Context(), []string{
		"list",
		"-R", "openclaw/octopool",
		"--json", "databaseId,displayTitle,number",
	}, &out)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if got := out.String(); !strings.Contains(got, `"displayTitle":"feat: preserve anonymous quota"`) || !strings.Contains(got, `"number":80`) {
		t.Fatalf("out = %s", got)
	}
}

func TestRunJobsFallsBackWhenPaginationIsRequired(t *testing.T) {
	_, err := runJobs(relayEnvelope{
		Status:       200,
		BodyEncoding: "json",
		Body:         []byte(`{"total_count":101,"jobs":[{"id":1}]}`),
	})
	if !isLocalFallback(err) {
		t.Fatalf("err = %v", err)
	}
}

func TestRunGHReleaseListKeepsIDSupport(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		return []map[string]any{{"id": 123}}
	})
	var out bytes.Buffer
	handled, err := runGHRelease(t.Context(), []string{
		"list",
		"-R", "openclaw/octopool",
		"--json", "id",
	}, &out)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if got := out.String(); !strings.Contains(got, `"id":123`) {
		t.Fatalf("out = %s", got)
	}
}

func TestRunGHReleaseViewRelaysTag(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/repos/openclaw/octopool/releases/tags/v0.2.5" {
			t.Fatalf("path = %v", body["path"])
		}
		headers, ok := body["headers"].(map[string]any)
		if !ok || headers["x-octopool-public-shape"] != "release-summary-v1" {
			t.Fatalf("headers = %#v", body["headers"])
		}
		return map[string]any{
			"tag_name": "v0.2.5",
			"name":     "0.2.5",
		}
	})
	var out bytes.Buffer
	handled, err := runGHRelease(t.Context(), []string{
		"view",
		"v0.2.5",
		"-R", "openclaw/octopool",
		"--json", "tagName,name",
	}, &out)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if got := out.String(); !strings.Contains(got, `"tagName":"v0.2.5"`) {
		t.Fatalf("out = %s", got)
	}
}

func TestRunGHReleaseViewIDStaysLocal(t *testing.T) {
	var out bytes.Buffer
	handled, err := runGHRelease(t.Context(), []string{
		"view",
		"v0.2.5",
		"-R", "openclaw/octopool",
		"--json", "id",
	}, &out)
	if err != nil || handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}

func TestRunGHReleaseViewKeepsNumericTags(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/repos/openclaw/octopool/releases/tags/20240530" {
			t.Fatalf("path = %v", body["path"])
		}
		return map[string]any{"tag_name": "20240530"}
	})
	var out bytes.Buffer
	handled, err := runGHRelease(t.Context(), []string{
		"view",
		"20240530",
		"-R", "openclaw/octopool",
		"--json", "tagName",
	}, &out)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if got := out.String(); !strings.Contains(got, `"tagName":"20240530"`) {
		t.Fatalf("out = %s", got)
	}
}

func TestRunGHReleaseViewEscapesSlashTagsOnce(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/repos/openclaw/octopool/releases/tags/release%2F1.0" {
			t.Fatalf("path = %v", body["path"])
		}
		return map[string]any{"tag_name": "release/1.0"}
	})
	var out bytes.Buffer
	handled, err := runGHRelease(t.Context(), []string{
		"view",
		"release/1.0",
		"-R", "openclaw/octopool",
		"--json", "tagName",
	}, &out)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if got := out.String(); !strings.Contains(got, `"tagName":"release/1.0"`) {
		t.Fatalf("out = %s", got)
	}
}

func TestRunGHWorkflowListRelays(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/repos/openclaw/octopool/actions/workflows" {
			t.Fatalf("path = %v", body["path"])
		}
		headers, ok := body["headers"].(map[string]any)
		if !ok || headers["x-octopool-public-shape"] != "workflow-list-v1" {
			t.Fatalf("headers = %#v", body["headers"])
		}
		query, _ := body["query"].(map[string]any)
		if query["per_page"] != "50" || query["page"] != "1" {
			t.Fatalf("query = %#v", query)
		}
		return map[string]any{"workflows": []map[string]any{
			{
				"id":    1,
				"name":  "CI",
				"path":  ".github/workflows/ci.yml",
				"state": "active",
			},
			{
				"id":    2,
				"name":  "Disabled",
				"path":  ".github/workflows/disabled.yml",
				"state": "disabled_manually",
			},
		}}
	})
	var out bytes.Buffer
	handled, err := runGHWorkflow(t.Context(), []string{
		"list",
		"-R", "openclaw/octopool",
		"--json", "id,name,path,state",
	}, &out)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if got := out.String(); !strings.Contains(got, `"name":"CI"`) {
		t.Fatalf("out = %s", got)
	}
	if got := out.String(); strings.Contains(got, "Disabled") {
		t.Fatalf("disabled workflow leaked into output: %s", got)
	}
}

func TestRunGHWorkflowViewUsesPublicShape(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/repos/openclaw/octopool/actions/workflows/ci.yml" {
			t.Fatalf("path = %v", body["path"])
		}
		headers, ok := body["headers"].(map[string]any)
		if !ok || headers["x-octopool-public-shape"] != "workflow-view-v1" {
			t.Fatalf("headers = %#v", body["headers"])
		}
		return map[string]any{
			"id":    1,
			"name":  "CI",
			"path":  ".github/workflows/ci.yml",
			"state": "active",
		}
	})
	var out bytes.Buffer
	handled, err := runGHWorkflow(t.Context(), []string{
		"view",
		"ci.yml",
		"-R", "openclaw/octopool",
		"--json", "id,name,path,state",
	}, &out)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}

func TestRunGHLabelListRelays(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/repos/openclaw/octopool/labels" {
			t.Fatalf("path = %v", body["path"])
		}
		headers, ok := body["headers"].(map[string]any)
		if !ok || headers["x-octopool-public-shape"] != "label-list-v1" {
			t.Fatalf("headers = %#v", body["headers"])
		}
		return []map[string]any{{"name": "bug", "color": "d73a4a", "description": "Bug"}}
	})
	var out bytes.Buffer
	handled, err := runGHLabel(t.Context(), []string{
		"list",
		"-R", "openclaw/octopool",
		"--json", "name,color,description",
	}, &out)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if got := out.String(); !strings.Contains(got, `"name":"bug"`) {
		t.Fatalf("out = %s", got)
	}
}

func TestRunGHPublicSummaryShapesFollowRequestedFields(t *testing.T) {
	var requests []map[string]any
	relayTestServer(t, func(body map[string]any) any {
		requests = append(requests, body)
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls":
			return []map[string]any{}
		case "/repos/openclaw/octopool/pulls/11":
			return map[string]any{"number": 11, "body": "Public body"}
		case "/repos/openclaw/octopool/issues/5":
			return map[string]any{"number": 5, "closed_at": "2026-05-27T23:19:04Z"}
		case "/repos/openclaw/octopool/issues":
			return []map[string]any{}
		default:
			t.Fatalf("path = %v", body["path"])
			return nil
		}
	})

	for _, args := range [][]string{
		{"list", "-R", "openclaw/octopool", "--json", "number,title"},
		{"list", "-R", "openclaw/octopool", "--json", "number,body"},
	} {
		var out bytes.Buffer
		handled, err := runGHPR(t.Context(), args, &out)
		if err != nil || !handled {
			t.Fatalf("pr handled=%v err=%v", handled, err)
		}
	}
	for _, args := range [][]string{
		{"view", "11", "-R", "openclaw/octopool", "--json", "number,headRefOid"},
		{"view", "11", "-R", "openclaw/octopool", "--json", "number,body"},
	} {
		var out bytes.Buffer
		handled, err := runGHPR(t.Context(), args, &out)
		if err != nil || !handled {
			t.Fatalf("pr view handled=%v err=%v", handled, err)
		}
	}
	for _, args := range [][]string{
		{"view", "5", "-R", "openclaw/octopool", "--json", "number,title"},
		{"view", "5", "-R", "openclaw/octopool", "--json", "number,closedAt"},
	} {
		var out bytes.Buffer
		handled, err := runGHIssue(t.Context(), args, &out)
		if err != nil || !handled {
			t.Fatalf("issue view handled=%v err=%v", handled, err)
		}
	}
	var out bytes.Buffer
	handled, err := runGHIssue(t.Context(), []string{
		"list",
		"-R", "openclaw/octopool",
		"--json", "number,closedAt",
	}, &out)
	if err != nil || !handled {
		t.Fatalf("issue list handled=%v err=%v", handled, err)
	}

	wantShapes := []string{"pr-list-v1", "", "pr-summary-v1", "", "issue-summary-v1", "", "issue-list-v1"}
	if len(requests) != len(wantShapes) {
		t.Fatalf("requests = %d", len(requests))
	}
	for index, want := range wantShapes {
		headers, _ := requests[index]["headers"].(map[string]any)
		got, _ := headers["x-octopool-public-shape"].(string)
		if got != want {
			t.Fatalf("request %d shape = %q, want %q", index, got, want)
		}
	}
}

func TestRunGHGistViewRelaysPublicGist(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/gists/abc123" {
			t.Fatalf("path = %v", body["path"])
		}
		return map[string]any{"id": "abc123", "html_url": "https://gist.github.com/abc123", "public": true}
	})
	var out bytes.Buffer
	handled, err := runGHGist(t.Context(), []string{
		"view",
		"abc123",
		"--json", "id,url,isPublic",
	}, &out)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if got := out.String(); !strings.Contains(got, `"isPublic":true`) || !strings.Contains(got, `"url":"https://gist.github.com/abc123"`) {
		t.Fatalf("out = %s", got)
	}
}

func TestRunGHSearchIssuesUsesScopedSearchRoute(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/search/issues" {
			t.Fatalf("path = %v", body["path"])
		}
		query := body["query"].(map[string]any)
		if query["per_page"] != "10" || query["q"] != "repo:openclaw/octopool type:issue cache regression" {
			t.Fatalf("query = %#v", query)
		}
		return map[string]any{
			"items": []map[string]any{{
				"number":   1,
				"title":    "cache hit regression",
				"body":     "octopool should pool this",
				"html_url": "https://github.com/openclaw/octopool/issues/1",
			}},
		}
	})
	var out bytes.Buffer
	handled, err := runGHSearch(t.Context(), []string{
		"issues",
		"-R", "openclaw/octopool",
		"cache",
		"regression",
		"--json", "number,title,url",
		"--limit", "10",
	}, &out)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	got := out.String()
	if !strings.Contains(got, `"number":1`) {
		t.Fatalf("out = %s", got)
	}
}

func TestRunGHSearchReposUsesRepositorySearchRoute(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/search/repositories" {
			t.Fatalf("path = %v", body["path"])
		}
		query := body["query"].(map[string]any)
		if query["q"] != "octopool relay" || query["per_page"] != "10" {
			t.Fatalf("query = %#v", query)
		}
		return map[string]any{
			"items": []map[string]any{{
				"name":      "octopool",
				"full_name": "openclaw/octopool",
				"html_url":  "https://github.com/openclaw/octopool",
			}},
		}
	})
	var out bytes.Buffer
	handled, err := runGHSearch(t.Context(), []string{
		"repos",
		"octopool",
		"relay",
		"--json", "name,nameWithOwner,url",
		"--limit", "10",
	}, &out)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if got := out.String(); !strings.Contains(got, `"nameWithOwner":"openclaw/octopool"`) {
		t.Fatalf("out = %s", got)
	}
}

func TestRunGHSearchReposRejectsOperators(t *testing.T) {
	var out bytes.Buffer
	handled, err := runGHSearch(t.Context(), []string{
		"repos",
		"octopool",
		"NOT",
		"relay",
		"--json", "name,nameWithOwner,url",
	}, &out)
	if err != nil || handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}

func TestRunGHSearchUsesExplicitStateOnly(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		query := body["query"].(map[string]any)
		if query["q"] != "repo:openclaw/octopool type:issue state:open cache" {
			t.Fatalf("query = %#v", query)
		}
		return map[string]any{"items": []map[string]any{}}
	})
	var out bytes.Buffer
	handled, err := runGHSearch(t.Context(), []string{
		"issues",
		"cache",
		"-R", "openclaw/octopool",
		"--state", "open",
		"--json", "number,title,url",
	}, &out)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}

func TestRunGHSearchFallsBackForInvalidStateAll(t *testing.T) {
	var out bytes.Buffer
	handled, err := runGHSearch(t.Context(), []string{
		"issues",
		"cache",
		"-R", "openclaw/octopool",
		"--state", "all",
		"--json", "number,title,url",
	}, &out)
	if err != nil || handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}

func TestRunGHSearchFallsBackForUnimplementedSort(t *testing.T) {
	var out bytes.Buffer
	handled, err := runGHSearch(t.Context(), []string{
		"issues",
		"cache",
		"-R", "openclaw/octopool",
		"--sort", "created",
		"--json", "number,title,url",
	}, &out)
	if err != nil || handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}

func TestRunGHSearchFallsBackForQualifiedQuery(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var out bytes.Buffer
	handled, err := runGHSearch(t.Context(), []string{
		"issues",
		"author:alice",
		"cache",
		"-R", "openclaw/octopool",
		"--json", "number,title,url",
	}, &out)
	if !handled || !isLocalFallback(err) {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}

func TestRunGHSearchFallsBackForUnsupportedTerm(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var out bytes.Buffer
	handled, err := runGHSearch(t.Context(), []string{
		"issues",
		"C++",
		"-R", "openclaw/octopool",
		"--json", "number,title,url",
	}, &out)
	if !handled || !isLocalFallback(err) {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}

func TestRunGHSearchFallsBackForQuotedPhrase(t *testing.T) {
	var out bytes.Buffer
	handled, err := runGHSearch(t.Context(), []string{
		"issues",
		"cache regression",
		"-R", "openclaw/octopool",
		"--json", "number,title,url",
	}, &out)
	if err != nil || handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}

func TestRunGHSearchPRsFallsBackForUnavailableFields(t *testing.T) {
	var out bytes.Buffer
	handled, err := runGHSearch(t.Context(), []string{
		"prs",
		"cache",
		"-R", "openclaw/octopool",
		"--json", "number,headRefName,isDraft",
	}, &out)
	if err != nil || handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}

func TestRunGHSearchFallsBackForMultipleRepos(t *testing.T) {
	var out bytes.Buffer
	handled, err := runGHSearch(t.Context(), []string{
		"issues",
		"cache",
		"-R", "openclaw/octopool",
		"-R", "openclaw/openclaw",
		"--json", "number,title,url",
	}, &out)
	if err != nil || handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}

func TestRunGHSearchFallsBackForNonSearchModifiers(t *testing.T) {
	var out bytes.Buffer
	handled, err := runGHSearch(t.Context(), []string{
		"prs",
		"cache",
		"-R", "openclaw/octopool",
		"--branch", "feature",
		"--json", "number,title,url",
	}, &out)
	if err != nil || handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}

func TestRunGHPRViewHydratesDetails(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls/7":
			return map[string]any{
				"number":   7,
				"title":    "hydrate pr",
				"html_url": "https://github.com/openclaw/octopool/pull/7",
			}
		case "/repos/openclaw/octopool/pulls/7/files":
			return []map[string]any{{"filename": "cmd/octopool/gh.go"}}
		case "/repos/openclaw/octopool/pulls/7/commits":
			return []map[string]any{{"sha": "abc1234"}}
		case "/repos/openclaw/octopool/issues/7/comments":
			return []map[string]any{{"body": "looks good"}}
		case "/repos/openclaw/octopool/pulls/7/reviews":
			return []map[string]any{{"state": "APPROVED"}}
		default:
			t.Fatalf("path = %v", body["path"])
			return nil
		}
	})
	var out bytes.Buffer
	handled, err := runGHPR(t.Context(), []string{
		"view",
		"7",
		"-R", "openclaw/octopool",
		"--json", "number,files,commits,comments,reviews",
	}, &out)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	got := out.String()
	for _, want := range []string{"cmd/octopool/gh.go", "abc1234", "looks good", "APPROVED"} {
		if !strings.Contains(got, want) {
			t.Fatalf("out missing %q: %s", want, got)
		}
	}
}

func TestRunGHPRViewFallsBackForStatusCheckRollup(t *testing.T) {
	var out bytes.Buffer
	handled, err := runGHPR(t.Context(), []string{
		"view",
		"7",
		"-R", "openclaw/octopool",
		"--json", "number,statusCheckRollup",
	}, &out)
	if err != nil || handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}

func TestRunGHPRChecksUsesCacheableRequests(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/repos/openclaw/octopool/pulls/7" {
			if _, ok := body["headers"]; ok {
				t.Fatalf("unexpected cache-bypass headers: %#v", body["headers"])
			}
		}
		if body["path"] == "/repos/openclaw/octopool/pulls/7" && body["headers"] == nil {
			t.Fatal("expected live PR head lookup header")
		}
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls/7":
			return map[string]any{"head": map[string]any{"sha": "abc1234"}}
		case "/repos/openclaw/octopool/commits/abc1234/check-runs":
			return map[string]any{"total_count": 1, "check_runs": []map[string]any{{"name": "CI", "status": "completed", "conclusion": "success"}}}
		case "/repos/openclaw/octopool/commits/abc1234/status":
			return map[string]any{"statuses": []map[string]any{}}
		default:
			t.Fatalf("path = %v", body["path"])
			return nil
		}
	})
	var out bytes.Buffer
	handled, err := runGHPR(t.Context(), []string{
		"checks",
		"7",
		"-R", "openclaw/octopool",
		"--json", "name,state",
	}, &out)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if got := out.String(); !strings.Contains(got, `"name":"CI"`) {
		t.Fatalf("out = %s", got)
	}
}

func relayTestServer(t *testing.T, responseBody func(map[string]any) any) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("OCTOPOOL_TOKEN", "test-token")
	t.Setenv("OCTOPOOL_POOL", "maintainers")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/github/request" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Fatalf("auth = %q", r.Header.Get("Authorization"))
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		envelope := relayEnvelope{
			Status:       200,
			BodyEncoding: "json",
		}
		raw, err := json.Marshal(responseBody(body))
		if err != nil {
			t.Fatal(err)
		}
		envelope.Body = raw
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(envelope); err != nil {
			t.Fatal(err)
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv("OCTOPOOL_URL", server.URL)
}

func TestFilterJSONFieldsUsesGHNames(t *testing.T) {
	raw := []byte(`{"number":85341,"title":"fix","html_url":"https://example.test/pr","head":{"ref":"feature","sha":"abc1234"},"draft":true}`)
	out, err := filterJSONFields(raw, []string{"number", "url", "headRefName", "headRefOid", "isDraft"}, fieldMapPR)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got["url"] != "https://example.test/pr" || got["headRefName"] != "feature" || got["headRefOid"] != "abc1234" || got["isDraft"] != true {
		t.Fatalf("filtered = %#v", got)
	}
}

func TestStatusItemsMapLegacyContexts(t *testing.T) {
	envelope := relayEnvelope{
		Status:       200,
		BodyEncoding: "json",
		Body:         []byte(`{"statuses":[{"context":"ci/external","state":"success","target_url":"https://example.test","created_at":"2026-05-27T00:00:00Z","updated_at":"2026-05-27T00:01:00Z"}]}`),
	}
	items, err := statusItems(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("items = %#v", items)
	}
	item := items[0].(map[string]any)
	if item["name"] != "ci/external" || item["conclusion"] != "success" || item["details_url"] != "https://example.test" {
		t.Fatalf("item = %#v", item)
	}
}

func TestParseGHAPIArgsFallsBackForMutation(t *testing.T) {
	_, fallback, err := parseGHAPIArgs([]string{"--method", "POST", "/repos/openclaw/openclaw/issues"})
	if err != nil {
		t.Fatal(err)
	}
	if !fallback {
		t.Fatal("expected fallback")
	}
}

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
