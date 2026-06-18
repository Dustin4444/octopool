package main

import (
	"context"
	"io"
	"strings"
)

func handleGHSearch(ctx context.Context, args []string, stdout io.Writer) ghResult {
	if len(args) < 2 {
		return ghDelegated()
	}
	kind := args[0]
	if kind != "issues" && kind != "prs" && kind != "repos" {
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
	if kind == "repos" {
		if opts.repo != "" || opts.repoCount > 0 || opts.state != "" || opts.patch || opts.branch != "" || opts.workflow != "" || opts.status != "" || opts.author != "" || opts.assignee != "" || len(opts.labels) > 0 || !machineReadable(opts) || !supportedJSONFields(opts, supportedRepoFields) || limitOverOnePage(opts) {
			return ghDelegated()
		}
		query, ok := plainSearchQuery(opts.positionals)
		if !ok || query == "" {
			return ghDelegated()
		}
		opts.positionals = nil
		return ghCompleted(relaySearchRepos(ctx, stdout, query, opts))
	}
	repo, ok := repoFromOptionOrCurrent(opts.repo)
	if !ok || repo == "" || opts.repoCount > 1 || !machineReadable(opts) || limitOverOnePage(opts) {
		return ghDelegated()
	}
	if opts.patch || opts.branch != "" || opts.workflow != "" || opts.status != "" {
		return ghDelegated()
	}
	if opts.state != "" && opts.state != "open" && opts.state != "closed" {
		return ghDelegated()
	}
	queryParts := opts.positionals
	for _, part := range queryParts {
		if strings.ContainsAny(part, " \t\r\n") {
			return ghDelegated()
		}
	}
	query := strings.TrimSpace(strings.Join(queryParts, " "))
	if query == "" {
		return ghDelegated()
	}
	opts.positionals = nil
	switch kind {
	case "issues":
		if !supportedJSONFields(opts, supportedIssueFields) {
			return ghDelegated()
		}
		return ghCompleted(relaySearchIssues(ctx, stdout, repo, query, opts))
	case "prs":
		if !supportedJSONFields(opts, supportedPRSearchFields) {
			return ghDelegated()
		}
		return ghCompleted(relaySearchPRs(ctx, stdout, repo, query, opts))
	default:
		return ghDelegated()
	}
}
