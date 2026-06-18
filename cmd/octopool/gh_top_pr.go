package main

import (
	"context"
	"encoding/json"
	"io"
	"strconv"
	"strings"
)

func handleGHPR(ctx context.Context, args []string, stdout io.Writer) ghResult {
	if len(args) == 0 {
		return ghDelegated()
	}
	opts, fallback, err := parseGHTopOptions(args[1:])
	if err != nil {
		return ghFailed(err)
	}
	if fallback {
		return ghDelegated()
	}
	if topJQFallback(opts) {
		return ghDelegated()
	}
	switch args[0] {
	case "view":
		repo, number, ok := repoNumber(opts)
		if !ok || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedPRFields) {
			return ghDelegated()
		}
		if needsHydratedPR(opts.json) {
			return ghCompleted(relayHydratedPRView(ctx, stdout, repo, number, opts))
		}
		return ghCompleted(relayTop(ctx, stdout, ghAPIRequest{
			method:  "GET",
			path:    repoPath(repo, "pulls", number),
			headers: publicShapeHeaders(opts, supportedPublicPRViewFields, "pr-summary-v1"),
		}, opts, fieldMapPR))
	case "list":
		repo, ok := repoOnly(opts)
		if !ok || !machineReadable(opts) || !supportedJSONFields(opts, supportedPRListFields) || !supportedPRListState(opts.state) || limitOverOnePage(opts) || opts.author != "" || opts.assignee != "" || len(opts.labels) > 0 {
			return ghDelegated()
		}
		query := listQuery(opts)
		if opts.state != "" {
			query["state"] = opts.state
		}
		return ghCompleted(relayTop(ctx, stdout, ghAPIRequest{
			method:  "GET",
			path:    repoPath(repo, "pulls"),
			query:   query,
			headers: publicShapeHeaders(opts, supportedPublicPRListFields, "pr-list-v1"),
		}, opts, fieldMapPR))
	case "diff":
		repo, number, ok := repoNumber(opts)
		if !ok || hasTopModifiersExceptPatch(opts) || machineReadable(opts) || opts.jq != "" {
			return ghDelegated()
		}
		accept := "application/vnd.github.v3.diff"
		if opts.patch {
			accept = "application/vnd.github.v3.patch"
		}
		request := ghAPIRequest{
			method:  "GET",
			path:    repoPath(repo, "pulls", number),
			headers: map[string]string{"accept": accept},
		}
		return ghCompleted(relayTop(ctx, stdout, request, ghTopOptions{}, nil))
	case "checks":
		repo, number, ok := repoNumber(opts)
		if !ok || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedCheckRunFields) {
			return ghDelegated()
		}
		return ghCompleted(relayPRChecks(ctx, stdout, repo, number, opts))
	default:
		return ghDelegated()
	}
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
