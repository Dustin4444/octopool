package main

import (
	"bytes"
	"strconv"
	"testing"
)

func TestRunGHPRChecksFallsBackWhenPaginationIsExhausted(t *testing.T) {
	checkRuns := make([]map[string]any, relayPageSize)
	for index := range checkRuns {
		checkRuns[index] = map[string]any{
			"name":       "check-" + strconv.Itoa(index),
			"status":     "completed",
			"conclusion": "success",
		}
	}
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls/7":
			return map[string]any{"head": map[string]any{"sha": "abc1234"}}
		case "/repos/openclaw/octopool/commits/abc1234/check-runs":
			return map[string]any{"total_count": maxRelayPages*relayPageSize + 1, "check_runs": checkRuns}
		default:
			return nil
		}
	})

	var out bytes.Buffer
	handled, err := runGHPR(t.Context(), []string{
		"checks", "7", "-R", "openclaw/octopool", "--json", "name,state",
	}, &out)
	if !handled || !isLocalFallback(err) {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}

func TestRunGHPRViewFallsBackWhenDetailPaginationIsExhausted(t *testing.T) {
	files := make([]map[string]any, relayPageSize)
	for index := range files {
		files[index] = map[string]any{"filename": "file-" + strconv.Itoa(index)}
	}
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls/7":
			return map[string]any{"number": 7}
		case "/repos/openclaw/octopool/pulls/7/files":
			return files
		default:
			return nil
		}
	})

	var out bytes.Buffer
	handled, err := runGHPR(t.Context(), []string{
		"view", "7", "-R", "openclaw/octopool", "--json", "number,files",
	}, &out)
	if !handled || !isLocalFallback(err) {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}

func TestRunGHIssueListFallsBackWhenFilteringExhaustsPagination(t *testing.T) {
	items := make([]map[string]any, relayPageSize)
	for index := range items {
		items[index] = map[string]any{
			"number":       index + 1,
			"pull_request": map[string]any{"url": "https://example.test"},
		}
	}
	relayTestServer(t, func(map[string]any) any { return items })

	var out bytes.Buffer
	handled, err := runGHIssue(t.Context(), []string{
		"list", "-R", "openclaw/octopool", "--limit", "1", "--json", "number",
	}, &out)
	if !handled || !isLocalFallback(err) {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}
