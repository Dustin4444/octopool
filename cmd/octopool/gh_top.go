package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
)

type ghTopOptions struct {
	repo        string
	repoCount   int
	json        []string
	jq          string
	patch       bool
	limit       string
	limitSet    bool
	state       string
	branch      string
	workflow    string
	status      string
	author      string
	assignee    string
	labels      []string
	positionals []string
}

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

type ghTopHandler func(context.Context, []string, io.Writer) (bool, error)

var ghTopHandlers = map[string]ghTopHandler{
	"pr":       runGHPR,
	"issue":    runGHIssue,
	"run":      runGHRun,
	"repo":     runGHRepo,
	"release":  runGHRelease,
	"workflow": runGHWorkflow,
	"label":    runGHLabel,
	"gist":     runGHGist,
	"search":   runGHSearch,
}

func runGHTopLevel(ctx context.Context, args []string, stdout io.Writer) ghResult {
	if len(args) < 2 {
		return ghResult{action: ghDelegate}
	}
	handler, ok := ghTopHandlers[args[0]]
	if !ok {
		return ghResult{action: ghDelegate}
	}
	handled, err := handler(ctx, args[1:], stdout)
	if err != nil {
		return ghResult{action: ghFail, err: err}
	}
	if handled {
		return ghResult{action: ghComplete}
	}
	return ghResult{action: ghDelegate}
}

func parseGHTopOptions(args []string) (ghTopOptions, bool, error) {
	opts := ghTopOptions{limit: "30"}
	for index := 0; index < len(args); index++ {
		arg := args[index]
		valueFlag := func(name string) (string, bool, error) {
			if arg == name {
				index++
				if index >= len(args) {
					return "", false, fmt.Errorf("%s requires a value", name)
				}
				return args[index], true, nil
			}
			if strings.HasPrefix(arg, name+"=") {
				return strings.TrimPrefix(arg, name+"="), true, nil
			}
			return "", false, nil
		}
		for _, item := range []struct {
			name string
			set  func(string)
		}{
			{"-R", func(value string) { opts.repo = value; opts.repoCount++ }},
			{"--repo", func(value string) { opts.repo = value; opts.repoCount++ }},
			{"--json", func(value string) { opts.json = splitFields(value) }},
			{"--jq", func(value string) { opts.jq = value }},
			{"-q", func(value string) { opts.jq = value }},
			{"--limit", func(value string) { opts.limit = value; opts.limitSet = true }},
			{"-L", func(value string) { opts.limit = value; opts.limitSet = true }},
			{"--state", func(value string) { opts.state = value }},
			{"--branch", func(value string) { opts.branch = value }},
			{"--workflow", func(value string) { opts.workflow = value }},
			{"--status", func(value string) { opts.status = value }},
			{"--author", func(value string) { opts.author = value }},
			{"--assignee", func(value string) { opts.assignee = value }},
			{"--label", func(value string) { opts.labels = append(opts.labels, value) }},
		} {
			value, ok, err := valueFlag(item.name)
			if err != nil {
				return opts, false, err
			}
			if ok {
				item.set(value)
				goto nextArg
			}
		}
		switch arg {
		case "--patch":
			opts.patch = true
		case "--web", "--comments", "--template", "--paginate", "--slurp":
			return opts, true, nil
		default:
			if strings.HasPrefix(arg, "-") && arg != "--patch" {
				return opts, true, nil
			}
			opts.positionals = append(opts.positionals, arg)
		}
	nextArg:
	}
	return opts, false, nil
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

func relayRunView(ctx context.Context, stdout io.Writer, repo string, id string, opts ghTopOptions) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	run := map[string]any{}
	if len(opts.json) > 1 || !hasJSONField(opts.json, "jobs") {
		envelope, err := client.do(ctx, ghAPIRequest{
			method:  "GET",
			path:    repoPath(repo, "actions", "runs", id),
			headers: map[string]string{"x-octopool-public-shape": "actions-summary-v1"},
		})
		if err != nil {
			return err
		}
		body, err := envelopeBodyBytes(envelope)
		if err != nil {
			return err
		}
		if err := json.Unmarshal(body, &run); err != nil {
			return err
		}
	}
	if hasJSONField(opts.json, "jobs") {
		envelope, err := client.do(ctx, ghAPIRequest{
			method: "GET",
			path:   repoPath(repo, "actions", "runs", id, "jobs"),
			query:  map[string]any{"per_page": "100"},
			headers: map[string]string{
				"x-octopool-public-shape": "actions-jobs-v1",
			},
		})
		if err != nil {
			return err
		}
		jobs, err := runJobs(envelope)
		if err != nil {
			return err
		}
		run["jobs"] = jobs
	}
	raw, err := json.Marshal(run)
	if err != nil {
		return err
	}
	filtered, err := filterJSONFields(raw, opts.json, fieldMapRun)
	if err != nil {
		return err
	}
	return writeBytes(ctx, stdout, filtered, opts.jq)
}

func runJobs(envelope relayEnvelope) ([]any, error) {
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return nil, err
	}
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, err
	}
	rawJobs, ok := response["jobs"].([]any)
	if !ok {
		return nil, errors.New("workflow jobs response did not include jobs")
	}
	if total, ok := response["total_count"].(float64); ok && total > float64(len(rawJobs)) {
		return nil, localFallbackError{Reason: "workflow jobs response requires pagination"}
	}
	jobs := make([]any, 0, len(rawJobs))
	for _, rawJob := range rawJobs {
		job, ok := rawJob.(map[string]any)
		if !ok {
			return nil, errors.New("workflow jobs response included an invalid job")
		}
		mapped := map[string]any{}
		for field, path := range map[string][]string{
			"databaseId":  {"id"},
			"name":        {"name"},
			"status":      {"status"},
			"conclusion":  {"conclusion"},
			"startedAt":   {"started_at"},
			"completedAt": {"completed_at"},
			"url":         {"html_url"},
		} {
			if value, ok := valueAtPath(job, path...); ok {
				mapped[field] = value
			}
		}
		if rawSteps, ok := job["steps"].([]any); ok {
			steps := make([]any, 0, len(rawSteps))
			for _, rawStep := range rawSteps {
				step, ok := rawStep.(map[string]any)
				if !ok {
					return nil, errors.New("workflow jobs response included an invalid step")
				}
				mappedStep := map[string]any{}
				for field, path := range map[string][]string{
					"name":        {"name"},
					"number":      {"number"},
					"status":      {"status"},
					"conclusion":  {"conclusion"},
					"startedAt":   {"started_at"},
					"completedAt": {"completed_at"},
				} {
					if value, ok := valueAtPath(step, path...); ok {
						mappedStep[field] = value
					}
				}
				steps = append(steps, mappedStep)
			}
			mapped["steps"] = steps
		}
		jobs = append(jobs, mapped)
	}
	return jobs, nil
}

func hasJSONField(fields []string, expected string) bool {
	for _, field := range fields {
		if field == expected {
			return true
		}
	}
	return false
}

func relayPRChecks(ctx context.Context, stdout io.Writer, repo string, number string, opts ghTopOptions) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	liveHeaders := map[string]string{"if-none-match": `"octopool-live"`}
	prEnvelope, err := client.do(ctx, ghAPIRequest{
		method:  "GET",
		path:    repoPath(repo, "pulls", number),
		headers: liveHeaders,
	})
	if err != nil {
		return err
	}
	prBody, err := envelopeBodyBytes(prEnvelope)
	if err != nil {
		return err
	}
	var pr map[string]any
	if err := json.Unmarshal(prBody, &pr); err != nil {
		return err
	}
	sha, ok := nestedString(pr, "head", "sha")
	if !ok || sha == "" {
		return errors.New("pull request response did not include head.sha")
	}
	items, err := prCheckItemsForSHA(ctx, client, repo, sha)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(items)
	if err != nil {
		return err
	}
	if len(opts.json) > 0 {
		raw, err = filterJSONFields(raw, opts.json, fieldMapCheckRun)
		if err != nil {
			return err
		}
	}
	if err := writeBytes(ctx, stdout, raw, opts.jq); err != nil {
		return err
	}
	return checkExitCode(items)
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

func prCheckItemsForSHA(ctx context.Context, client ghRelayClient, repo string, sha string) ([]any, error) {
	checkRuns := []any{}
	totalCheckRuns := 0
	for page := 1; page <= 10; page++ {
		request := ghAPIRequest{
			method: "GET",
			path:   repoPath(repo, "commits", sha, "check-runs"),
			query:  map[string]any{"per_page": "100", "page": strconv.Itoa(page)},
		}
		checkRunsEnvelope, err := client.do(ctx, request)
		if err != nil {
			return nil, err
		}
		items, total, err := checkRunItems(checkRunsEnvelope)
		if err != nil {
			return nil, err
		}
		if page == 1 {
			totalCheckRuns = total
		}
		checkRuns = append(checkRuns, items...)
		if len(checkRuns) >= totalCheckRuns || len(items) < 100 {
			break
		}
	}
	statusEnvelope, err := client.do(ctx, ghAPIRequest{
		method: "GET",
		path:   repoPath(repo, "commits", sha, "status"),
	})
	if err != nil {
		return nil, err
	}
	statuses, err := statusItems(statusEnvelope)
	if err != nil {
		return nil, err
	}
	return ghCheckItems(append(checkRuns, statuses...)), nil
}

func relayIssueList(ctx context.Context, stdout io.Writer, request ghAPIRequest, opts ghTopOptions) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	limit := desiredLimit(opts)
	perPage := 100
	filtered := make([]map[string]any, 0, limit)
	for page := 1; page <= 10 && len(filtered) < limit; page++ {
		paged := request
		paged.query = cloneQuery(request.query)
		paged.query["per_page"] = strconv.Itoa(perPage)
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
		if len(items) < perPage {
			break
		}
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
	for page := 1; page <= 10; page++ {
		envelope, err := client.do(ctx, ghAPIRequest{
			method: "GET",
			path:   path,
			query:  map[string]any{"per_page": "100", "page": strconv.Itoa(page)},
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
		if len(pageItems) < 100 {
			break
		}
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

func checkRunItems(envelope relayEnvelope) ([]any, int, error) {
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return nil, 0, err
	}
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, 0, err
	}
	items, ok := response["check_runs"].([]any)
	if !ok {
		return nil, 0, errors.New("check-runs response did not include check_runs")
	}
	total := len(items)
	if value, ok := response["total_count"].(float64); ok {
		total = int(value)
	}
	return items, total, nil
}

func statusItems(envelope relayEnvelope) ([]any, error) {
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return nil, err
	}
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, err
	}
	rawItems, ok := response["statuses"].([]any)
	if !ok {
		return nil, errors.New("status response did not include statuses")
	}
	items := make([]any, 0, len(rawItems))
	for _, raw := range rawItems {
		status, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		state, _ := status["state"].(string)
		displayStatus := "completed"
		if strings.EqualFold(state, "pending") {
			displayStatus = "pending"
		}
		item := map[string]any{
			"name":         status["context"],
			"context":      status["context"],
			"status":       displayStatus,
			"conclusion":   status["state"],
			"details_url":  status["target_url"],
			"started_at":   status["created_at"],
			"completed_at": status["updated_at"],
		}
		items = append(items, item)
	}
	return items, nil
}

func ghCheckItems(items []any) []any {
	out := make([]any, 0, len(items))
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		state := ghCheckState(item)
		out = append(out, map[string]any{
			"bucket":      ghCheckBucket(state),
			"completedAt": firstString(item, "completed_at", "completedAt"),
			"description": ghCheckDescription(item),
			"event":       nestedStringValue(item, "check_suite", "event"),
			"link":        firstString(item, "details_url", "target_url", "link"),
			"name":        firstString(item, "name", "context"),
			"startedAt":   firstString(item, "started_at", "created_at", "startedAt"),
			"state":       state,
			"workflow":    ghCheckWorkflow(item),
		})
	}
	return out
}

func ghCheckState(item map[string]any) string {
	status := strings.ToLower(firstString(item, "status"))
	conclusion := strings.ToLower(firstString(item, "conclusion"))
	if status != "" && status != "completed" {
		return strings.ToUpper(status)
	}
	if conclusion == "" {
		return strings.ToUpper(status)
	}
	return strings.ToUpper(conclusion)
}

func ghCheckBucket(state string) string {
	switch strings.ToLower(state) {
	case "success", "neutral":
		return "pass"
	case "failure", "error", "timed_out", "action_required":
		return "fail"
	case "cancelled":
		return "cancel"
	case "skipped":
		return "skipping"
	default:
		return "pending"
	}
}

func ghCheckDescription(item map[string]any) string {
	if description := firstString(item, "description"); description != "" {
		return description
	}
	return nestedStringValue(item, "output", "summary")
}

func ghCheckWorkflow(item map[string]any) string {
	if workflow := firstString(item, "workflow"); workflow != "" {
		return workflow
	}
	return nestedStringValue(item, "check_suite", "workflow_name")
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

func checkExitCode(items []any) error {
	exitCode := 0
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		bucket, _ := item["bucket"].(string)
		state, _ := item["state"].(string)
		switch strings.ToLower(bucket) {
		case "fail", "cancel":
			exitCode = 1
		case "pending":
			if exitCode == 0 {
				exitCode = 8
			}
		}
		if bucket == "" && strings.ToLower(state) != "success" && strings.ToLower(state) != "neutral" && exitCode == 0 {
			exitCode = 8
		}
	}
	if exitCode != 0 {
		return exitCodeError{Code: exitCode}
	}
	return nil
}

func listQuery(opts ghTopOptions) map[string]any {
	return listQueryDefault(opts, 30)
}

func listQueryDefault(opts ghTopOptions, defaultLimit int) map[string]any {
	return map[string]any{"per_page": strconv.Itoa(desiredLimitDefault(opts, defaultLimit))}
}

func desiredLimit(opts ghTopOptions) int {
	return desiredLimitDefault(opts, 30)
}

func desiredLimitDefault(opts ghTopOptions, defaultLimit int) int {
	perPage := "30"
	if !opts.limitSet {
		perPage = strconv.Itoa(defaultLimit)
	}
	if opts.limitSet {
		limit, err := strconv.Atoi(opts.limit)
		if err != nil {
			value, _ := strconv.Atoi(perPage)
			return value
		}
		if limit < 1 {
			perPage = "1"
		} else if limit > 100 {
			perPage = "100"
		} else {
			perPage = strconv.Itoa(limit)
		}
	}
	value, _ := strconv.Atoi(perPage)
	return value
}

func limitOverOnePage(opts ghTopOptions) bool {
	limit, err := strconv.Atoi(opts.limit)
	return err == nil && limit > 100
}

func cloneQuery(input map[string]any) map[string]any {
	out := make(map[string]any, len(input)+2)
	for key, value := range input {
		out[key] = value
	}
	return out
}

func splitFields(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' '
	})
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func isDigits(raw string) bool {
	return regexp.MustCompile(`^[0-9]+$`).MatchString(raw)
}

func nestedString(input map[string]any, path ...string) (string, bool) {
	value, ok := valueAtPath(input, path...)
	if !ok {
		return "", false
	}
	text, ok := value.(string)
	return text, ok
}
