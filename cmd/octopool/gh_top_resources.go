package main

import (
	"context"
	"io"
)

func handleGHRepo(ctx context.Context, args []string, stdout io.Writer) ghResult {
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
		if hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedRepoFields) {
			return ghDelegated()
		}
		if opts.repo == "" && len(opts.positionals) == 1 {
			opts.repo = opts.positionals[0]
			opts.positionals = nil
		}
		repo, ok := repoOnly(opts)
		if !ok {
			return ghDelegated()
		}
		return ghCompleted(relayTop(ctx, stdout, ghAPIRequest{method: "GET", path: repoPath(repo)}, opts, fieldMapRepo))
	case "list":
		return ghDelegated()
	default:
		return ghDelegated()
	}
}

func handleGHRelease(ctx context.Context, args []string, stdout io.Writer) ghResult {
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
	case "list":
		repo, ok := repoOnly(opts)
		if !ok || !machineReadable(opts) || !supportedJSONFields(opts, supportedReleaseFields) || limitOverOnePage(opts) {
			return ghDelegated()
		}
		return ghCompleted(relayTop(ctx, stdout, ghAPIRequest{method: "GET", path: repoPath(repo, "releases"), query: listQuery(opts)}, opts, fieldMapRelease))
	case "view":
		repo, ok := repoFromOptionOrCurrent(opts.repo)
		if !ok || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedReleaseViewFields) {
			return ghDelegated()
		}
		path := repoPath(repo, "releases", "latest")
		if len(opts.positionals) == 1 {
			path = repoPath(repo, "releases", "tags", opts.positionals[0])
		} else if len(opts.positionals) > 1 {
			return ghDelegated()
		}
		return ghCompleted(relayTop(ctx, stdout, ghAPIRequest{
			method:  "GET",
			path:    path,
			headers: map[string]string{"x-octopool-public-shape": "release-summary-v1"},
		}, opts, fieldMapRelease))
	default:
		return ghDelegated()
	}
}

func handleGHWorkflow(ctx context.Context, args []string, stdout io.Writer) ghResult {
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
	repo, ok := repoFromOptionOrCurrent(opts.repo)
	if !ok || repo == "" {
		return ghDelegated()
	}
	switch args[0] {
	case "list":
		if len(opts.positionals) != 0 || opts.patch || opts.state != "" || opts.branch != "" || opts.workflow != "" || opts.status != "" || opts.author != "" || opts.assignee != "" || len(opts.labels) > 0 || !machineReadable(opts) || !supportedJSONFields(opts, supportedWorkflowFields) || limitOverOnePage(opts) {
			return ghDelegated()
		}
		return ghCompleted(relayWorkflowList(ctx, stdout, repo, opts))
	case "view":
		if len(opts.positionals) != 1 || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedWorkflowFields) || !supportedWorkflowRef(opts.positionals[0]) {
			return ghDelegated()
		}
		return ghCompleted(relayTop(ctx, stdout, ghAPIRequest{
			method:  "GET",
			path:    repoPath(repo, "actions", "workflows", opts.positionals[0]),
			headers: map[string]string{"x-octopool-public-shape": "workflow-view-v1"},
		}, opts, fieldMapWorkflow))
	default:
		return ghDelegated()
	}
}

func handleGHLabel(ctx context.Context, args []string, stdout io.Writer) ghResult {
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
	if args[0] != "list" || opts.patch || opts.state != "" || opts.branch != "" || opts.workflow != "" || opts.status != "" || opts.author != "" || opts.assignee != "" || len(opts.labels) > 0 || !machineReadable(opts) || !supportedJSONFields(opts, supportedLabelFields) || limitOverOnePage(opts) {
		return ghDelegated()
	}
	repo, ok := repoOnly(opts)
	if !ok {
		return ghDelegated()
	}
	return ghCompleted(relayTop(ctx, stdout, ghAPIRequest{
		method:  "GET",
		path:    repoPath(repo, "labels"),
		query:   listQuery(opts),
		headers: map[string]string{"x-octopool-public-shape": "label-list-v1"},
	}, opts, fieldMapLabel))
}

func handleGHGist(ctx context.Context, args []string, stdout io.Writer) ghResult {
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
	case "list":
		return ghDelegated()
	case "view":
		if len(opts.positionals) != 1 || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedGistFields) || !isHex(opts.positionals[0]) {
			return ghDelegated()
		}
		return ghCompleted(relayTop(ctx, stdout, ghAPIRequest{method: "GET", path: "/gists/" + opts.positionals[0]}, opts, fieldMapGist))
	default:
		return ghDelegated()
	}
}
