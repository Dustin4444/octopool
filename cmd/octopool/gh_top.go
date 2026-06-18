package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

const (
	relayPageSize = 100
	maxRelayPages = 10
)

type ghAction uint8

const (
	ghDelegate ghAction = iota
	ghComplete
	ghFail
)

type ghResult struct {
	action ghAction
	err    error
}

type ghTopHandler func(context.Context, []string, io.Writer) ghResult

var ghTopHandlers = map[string]ghTopHandler{
	"pr":       handleGHPR,
	"issue":    handleGHIssue,
	"run":      handleGHRun,
	"repo":     handleGHRepo,
	"release":  handleGHRelease,
	"workflow": handleGHWorkflow,
	"label":    handleGHLabel,
	"gist":     handleGHGist,
	"search":   handleGHSearch,
}

func runGHTopLevel(ctx context.Context, args []string, stdout io.Writer) ghResult {
	if len(args) < 2 {
		return ghResult{action: ghDelegate}
	}
	handler, ok := ghTopHandlers[args[0]]
	if !ok {
		return ghResult{action: ghDelegate}
	}
	return handler(ctx, args[1:], stdout)
}

func ghDelegated() ghResult {
	return ghResult{action: ghDelegate}
}

func ghCompleted(err error) ghResult {
	if err != nil {
		return ghResult{action: ghFail, err: err}
	}
	return ghResult{action: ghComplete}
}

func ghFailed(err error) ghResult {
	return ghResult{action: ghFail, err: err}
}

func relayTop(ctx context.Context, stdout io.Writer, request ghAPIRequest, opts ghTopOptions, fieldMap map[string][]string) error {
	if request.query == nil {
		request.query = map[string]any{}
	}
	if request.headers == nil {
		request.headers = map[string]string{}
	}
	if !safeRelayRequest(request) {
		return errors.New("internal error: top-level gh command built an unsupported relay request")
	}
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	envelope, err := client.do(ctx, request)
	if err != nil {
		return err
	}
	if len(opts.json) == 0 {
		return writeGHBody(ctx, stdout, envelope, opts.jq)
	}
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return err
	}
	filtered, err := filterJSONFields(body, opts.json, fieldMap)
	if err != nil {
		return err
	}
	if opts.jq != "" {
		return writeBytes(ctx, stdout, filtered, opts.jq)
	}
	return writeBytes(ctx, stdout, filtered, "")
}

func relayHydratedPRView(ctx context.Context, stdout io.Writer, repo string, number string, opts ghTopOptions) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	prEnvelope, err := client.do(ctx, ghAPIRequest{method: "GET", path: repoPath(repo, "pulls", number)})
	if err != nil {
		return err
	}
	body, err := envelopeBodyBytes(prEnvelope)
	if err != nil {
		return err
	}
	var pr map[string]any
	if err := json.Unmarshal(body, &pr); err != nil {
		return err
	}
	for _, field := range opts.json {
		switch field {
		case "files":
			files, err := relayPagedArray(ctx, client, repoPath(repo, "pulls", number, "files"))
			if err != nil {
				return err
			}
			pr["files"] = mapPRFiles(files)
		case "commits":
			commits, err := relayPagedArray(ctx, client, repoPath(repo, "pulls", number, "commits"))
			if err != nil {
				return err
			}
			pr["commits"] = mapPRCommits(commits)
		case "comments":
			comments, err := relayPagedArray(ctx, client, repoPath(repo, "issues", number, "comments"))
			if err != nil {
				return err
			}
			pr["comments"] = mapPRComments(comments)
		case "reviews":
			reviews, err := relayPagedArray(ctx, client, repoPath(repo, "pulls", number, "reviews"))
			if err != nil {
				return err
			}
			pr["reviews"] = mapPRReviews(reviews)
		}
	}
	raw, err := json.Marshal(pr)
	if err != nil {
		return err
	}
	filtered, err := filterJSONFields(raw, opts.json, fieldMapPR)
	if err != nil {
		return err
	}
	return writeBytes(ctx, stdout, filtered, opts.jq)
}

func relayIssueList(ctx context.Context, stdout io.Writer, request ghAPIRequest, opts ghTopOptions) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	limit := desiredLimit(opts)
	filtered := make([]map[string]any, 0, limit)
	complete := false
	for page := 1; page <= maxRelayPages && len(filtered) < limit; page++ {
		paged := request
		paged.query = cloneQuery(request.query)
		paged.query["per_page"] = strconv.Itoa(relayPageSize)
		paged.query["page"] = strconv.Itoa(page)
		envelope, err := client.do(ctx, paged)
		if err != nil {
			return err
		}
		body, err := envelopeBodyBytes(envelope)
		if err != nil {
			return err
		}
		var items []map[string]any
		if err := json.Unmarshal(body, &items); err != nil {
			return err
		}
		for _, item := range items {
			if _, ok := item["pull_request"]; !ok {
				filtered = append(filtered, item)
				if len(filtered) >= limit {
					break
				}
			}
		}
		if len(items) < relayPageSize {
			complete = true
			break
		}
	}
	if len(filtered) < limit && !complete {
		return localFallbackError{Reason: "pagination_exhausted"}
	}
	raw, err := json.Marshal(filtered)
	if err != nil {
		return err
	}
	if len(opts.json) > 0 {
		raw, err = filterJSONFields(raw, opts.json, fieldMapIssue)
		if err != nil {
			return err
		}
	}
	return writeBytes(ctx, stdout, raw, opts.jq)
}

func relaySearchIssues(ctx context.Context, stdout io.Writer, repo string, rawQuery string, opts ghTopOptions) error {
	if opts.author != "" || opts.assignee != "" || len(opts.labels) > 0 {
		return localFallbackError{Reason: "unsupported_search_filter"}
	}
	return relayGitHubSearch(ctx, stdout, repo, rawQuery, "issue", opts, fieldMapIssue)
}

func relayWorkflowList(ctx context.Context, stdout io.Writer, repo string, opts ghTopOptions) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	limit := desiredLimitDefault(opts, 50)
	items := make([]any, 0, limit)
	// Native gh fetches one page at --limit, then drops disabled workflows without backfilling.
	envelope, err := client.do(ctx, ghAPIRequest{
		method:  "GET",
		path:    repoPath(repo, "actions", "workflows"),
		query:   map[string]any{"per_page": strconv.Itoa(limit), "page": "1"},
		headers: map[string]string{"x-octopool-public-shape": "workflow-list-v1"},
	})
	if err != nil {
		return err
	}
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return err
	}
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		return err
	}
	workflows, ok := response["workflows"].([]any)
	if !ok {
		return errors.New("workflow list response did not include workflows")
	}
	for _, item := range workflows {
		if workflowActive(item) {
			items = append(items, item)
		}
	}
	raw, err := json.Marshal(items)
	if err != nil {
		return err
	}
	if len(opts.json) > 0 {
		raw, err = filterJSONFields(raw, opts.json, fieldMapWorkflow)
		if err != nil {
			return err
		}
	}
	return writeBytes(ctx, stdout, raw, opts.jq)
}

func workflowActive(item any) bool {
	workflow, ok := item.(map[string]any)
	return ok && workflow["state"] == "active"
}

func relaySearchPRs(ctx context.Context, stdout io.Writer, repo string, rawQuery string, opts ghTopOptions) error {
	if opts.author != "" || opts.assignee != "" || len(opts.labels) > 0 {
		return localFallbackError{Reason: "unsupported_pr_search_filter"}
	}
	return relayGitHubSearch(ctx, stdout, repo, rawQuery, "pr", opts, fieldMapPR)
}

func relaySearchRepos(ctx context.Context, stdout io.Writer, rawQuery string, opts ghTopOptions) error {
	terms, ok := searchTerms(rawQuery)
	if !ok || len(terms) == 0 {
		return localFallbackError{Reason: "unsupported_repo_search_query"}
	}
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	envelope, err := client.do(ctx, ghAPIRequest{
		method: "GET",
		path:   "/search/repositories",
		query:  map[string]any{"q": strings.Join(terms, " "), "per_page": strconv.Itoa(desiredLimit(opts))},
	})
	if err != nil {
		return err
	}
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return err
	}
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		return err
	}
	items, _ := response["items"].([]any)
	raw, err := json.Marshal(items)
	if err != nil {
		return err
	}
	if len(opts.json) > 0 {
		raw, err = filterJSONFields(raw, opts.json, fieldMapRepo)
		if err != nil {
			return err
		}
	}
	return writeBytes(ctx, stdout, raw, opts.jq)
}

func relayGitHubSearch(
	ctx context.Context,
	stdout io.Writer,
	repo string,
	rawQuery string,
	searchType string,
	opts ghTopOptions,
	fieldMap map[string][]string,
) error {
	terms, ok := searchTerms(rawQuery)
	if !ok {
		return localFallbackError{Reason: "unsupported_search_query"}
	}
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	q := fmt.Sprintf("repo:%s type:%s", repo, searchType)
	if opts.state != "" {
		q += " state:" + opts.state
	}
	if len(terms) > 0 {
		q += " " + strings.Join(terms, " ")
	}
	envelope, err := client.do(ctx, ghAPIRequest{
		method: "GET",
		path:   "/search/issues",
		query:  map[string]any{"q": q, "per_page": strconv.Itoa(desiredLimit(opts))},
	})
	if err != nil {
		return err
	}
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return err
	}
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		return err
	}
	items, _ := response["items"].([]any)
	raw, err := json.Marshal(items)
	if err != nil {
		return err
	}
	if len(opts.json) > 0 {
		raw, err = filterJSONFields(raw, opts.json, fieldMap)
		if err != nil {
			return err
		}
	}
	return writeBytes(ctx, stdout, raw, opts.jq)
}

func relayPagedArray(ctx context.Context, client ghRelayClient, path string) ([]any, error) {
	items := []any{}
	complete := false
	for page := 1; page <= maxRelayPages; page++ {
		envelope, err := client.do(ctx, ghAPIRequest{
			method: "GET",
			path:   path,
			query:  map[string]any{"per_page": strconv.Itoa(relayPageSize), "page": strconv.Itoa(page)},
		})
		if err != nil {
			return nil, err
		}
		body, err := envelopeBodyBytes(envelope)
		if err != nil {
			return nil, err
		}
		var pageItems []any
		if err := json.Unmarshal(body, &pageItems); err != nil {
			return nil, err
		}
		items = append(items, pageItems...)
		if len(pageItems) < relayPageSize {
			complete = true
			break
		}
	}
	if !complete {
		return nil, localFallbackError{Reason: "pagination_exhausted"}
	}
	return items, nil
}

func mapPRFiles(items []any) []any {
	return mapObjects(items, func(item map[string]any) map[string]any {
		return map[string]any{
			"path":         firstString(item, "filename"),
			"additions":    item["additions"],
			"deletions":    item["deletions"],
			"changeType":   item["status"],
			"originalPath": firstString(item, "previous_filename"),
		}
	})
}

func mapPRCommits(items []any) []any {
	return mapObjects(items, func(item map[string]any) map[string]any {
		commit, _ := item["commit"].(map[string]any)
		message := firstString(commit, "message")
		headline, body, _ := strings.Cut(message, "\n\n")
		if headline == "" {
			headline = message
		}
		return map[string]any{
			"oid":             firstString(item, "sha"),
			"messageHeadline": headline,
			"messageBody":     body,
			"committedDate":   nestedStringValue(item, "commit", "committer", "date"),
			"authoredDate":    nestedStringValue(item, "commit", "author", "date"),
			"url":             firstString(item, "html_url"),
			"authors":         commitAuthors(item),
		}
	})
}

func mapPRComments(items []any) []any {
	return mapObjects(items, func(item map[string]any) map[string]any {
		return map[string]any{
			"author":    item["user"],
			"body":      item["body"],
			"createdAt": item["created_at"],
			"updatedAt": item["updated_at"],
			"url":       item["html_url"],
		}
	})
}

func mapPRReviews(items []any) []any {
	return mapObjects(items, func(item map[string]any) map[string]any {
		return map[string]any{
			"author":      item["user"],
			"body":        item["body"],
			"state":       item["state"],
			"submittedAt": item["submitted_at"],
			"url":         item["html_url"],
		}
	})
}

func mapObjects(items []any, mapper func(map[string]any) map[string]any) []any {
	out := make([]any, 0, len(items))
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, mapper(item))
	}
	return out
}

func commitAuthors(item map[string]any) []any {
	login := nestedStringValue(item, "author", "login")
	if login == "" {
		login = nestedStringValue(item, "commit", "author", "name")
	}
	if login == "" {
		return []any{}
	}
	return []any{map[string]any{"login": login}}
}

func searchTerms(raw string) ([]string, bool) {
	fields := strings.Fields(strings.ToLower(raw))
	terms := make([]string, 0, len(fields))
	for _, field := range fields {
		if strings.Contains(field, ":") || strings.HasPrefix(field, "-") || field == "or" || field == "not" {
			return nil, false
		}
		term := strings.Trim(field, `"'`)
		if term == "" {
			continue
		}
		if !allowedSearchTerm.MatchString(term) {
			return nil, false
		}
		terms = append(terms, term)
	}
	return terms, true
}

func plainSearchQuery(parts []string) (string, bool) {
	for _, part := range parts {
		if strings.ContainsAny(part, " \t\r\n") {
			return "", false
		}
	}
	terms, ok := searchTerms(strings.Join(parts, " "))
	if !ok {
		return "", false
	}
	return strings.Join(terms, " "), true
}

func firstString(item map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := item[key].(string); ok {
			return value
		}
	}
	return ""
}

func nestedStringValue(item map[string]any, path ...string) string {
	value, ok := valueAtPath(item, path...)
	if !ok {
		return ""
	}
	text, _ := value.(string)
	return text
}
