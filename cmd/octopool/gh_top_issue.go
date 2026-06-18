package main

import (
	"context"
	"io"
	"strings"
)

func handleGHIssue(ctx context.Context, args []string, stdout io.Writer) ghResult {
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
		if !ok || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedIssueFields) {
			return ghDelegated()
		}
		return ghCompleted(relayTop(ctx, stdout, ghAPIRequest{
			method:  "GET",
			path:    repoPath(repo, "issues", number),
			headers: publicShapeHeaders(opts, supportedPublicIssueViewFields, "issue-summary-v1"),
		}, opts, fieldMapIssue))
	case "list":
		repo, ok := repoOnly(opts)
		if !ok || !machineReadable(opts) || !supportedJSONFields(opts, supportedIssueFields) || limitOverOnePage(opts) || hasCurrentUserFilter(opts) {
			return ghDelegated()
		}
		query := listQuery(opts)
		if opts.state != "" {
			query["state"] = opts.state
		}
		if opts.author != "" {
			query["creator"] = opts.author
		}
		if opts.assignee != "" {
			query["assignee"] = opts.assignee
		}
		if len(opts.labels) > 0 {
			query["labels"] = strings.Join(opts.labels, ",")
		}
		return ghCompleted(relayIssueList(ctx, stdout, ghAPIRequest{
			method:  "GET",
			path:    repoPath(repo, "issues"),
			query:   query,
			headers: publicShapeHeaders(opts, supportedPublicIssueListFields, "issue-list-v1"),
		}, opts))
	default:
		return ghDelegated()
	}
}
