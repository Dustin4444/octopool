package main

import (
	"context"
	"io"
	"strings"
)

func runGHSearch(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	if len(args) < 2 {
		return false, nil
	}
	kind := args[0]
	if kind != "issues" && kind != "prs" && kind != "repos" {
		return false, nil
	}
	opts, fallback, err := parseGHTopOptions(args[1:])
	if err != nil || fallback {
		return !fallback, err
	}
	if topJQFallback(opts) {
		return false, nil
	}
	if kind == "repos" {
		if opts.repo != "" || opts.repoCount > 0 || opts.state != "" || opts.patch || opts.branch != "" || opts.workflow != "" || opts.status != "" || opts.author != "" || opts.assignee != "" || len(opts.labels) > 0 || !machineReadable(opts) || !supportedJSONFields(opts, supportedRepoFields) || limitOverOnePage(opts) {
			return false, nil
		}
		query, ok := plainSearchQuery(opts.positionals)
		if !ok || query == "" {
			return false, nil
		}
		opts.positionals = nil
		return true, relaySearchRepos(ctx, stdout, query, opts)
	}
	repo, ok := repoFromOptionOrCurrent(opts.repo)
	if !ok || repo == "" || opts.repoCount > 1 || !machineReadable(opts) || limitOverOnePage(opts) {
		return false, nil
	}
	if opts.patch || opts.branch != "" || opts.workflow != "" || opts.status != "" {
		return false, nil
	}
	if opts.state != "" && opts.state != "open" && opts.state != "closed" {
		return false, nil
	}
	queryParts := opts.positionals
	for _, part := range queryParts {
		if strings.ContainsAny(part, " \t\r\n") {
			return false, nil
		}
	}
	query := strings.TrimSpace(strings.Join(queryParts, " "))
	if query == "" {
		return false, nil
	}
	opts.positionals = nil
	switch kind {
	case "issues":
		if !supportedJSONFields(opts, supportedIssueFields) {
			return false, nil
		}
		return true, relaySearchIssues(ctx, stdout, repo, query, opts)
	case "prs":
		if !supportedJSONFields(opts, supportedPRSearchFields) {
			return false, nil
		}
		return true, relaySearchPRs(ctx, stdout, repo, query, opts)
	default:
		return false, nil
	}
}
