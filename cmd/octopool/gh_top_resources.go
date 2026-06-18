package main

import (
	"context"
	"io"
)

func runGHRepo(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	opts, fallback, err := parseGHTopOptions(args[1:])
	if err != nil || fallback {
		return !fallback, err
	}
	if topJQFallback(opts) {
		return false, nil
	}
	switch args[0] {
	case "view":
		if hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedRepoFields) {
			return false, nil
		}
		if opts.repo == "" && len(opts.positionals) == 1 {
			opts.repo = opts.positionals[0]
			opts.positionals = nil
		}
		repo, ok := repoOnly(opts)
		if !ok {
			return false, nil
		}
		return true, relayTop(ctx, stdout, ghAPIRequest{method: "GET", path: repoPath(repo)}, opts, fieldMapRepo)
	case "list":
		return false, nil
	default:
		return false, nil
	}
}

func runGHRelease(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	opts, fallback, err := parseGHTopOptions(args[1:])
	if err != nil || fallback {
		return !fallback, err
	}
	if topJQFallback(opts) {
		return false, nil
	}
	switch args[0] {
	case "list":
		repo, ok := repoOnly(opts)
		if !ok || !machineReadable(opts) || !supportedJSONFields(opts, supportedReleaseFields) || limitOverOnePage(opts) {
			return false, nil
		}
		return true, relayTop(ctx, stdout, ghAPIRequest{method: "GET", path: repoPath(repo, "releases"), query: listQuery(opts)}, opts, fieldMapRelease)
	case "view":
		repo, ok := repoFromOptionOrCurrent(opts.repo)
		if !ok || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedReleaseViewFields) {
			return false, nil
		}
		path := repoPath(repo, "releases", "latest")
		if len(opts.positionals) == 1 {
			path = repoPath(repo, "releases", "tags", opts.positionals[0])
		} else if len(opts.positionals) > 1 {
			return false, nil
		}
		return true, relayTop(ctx, stdout, ghAPIRequest{
			method:  "GET",
			path:    path,
			headers: map[string]string{"x-octopool-public-shape": "release-summary-v1"},
		}, opts, fieldMapRelease)
	default:
		return false, nil
	}
}

func runGHWorkflow(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	opts, fallback, err := parseGHTopOptions(args[1:])
	if err != nil || fallback {
		return !fallback, err
	}
	if topJQFallback(opts) {
		return false, nil
	}
	repo, ok := repoFromOptionOrCurrent(opts.repo)
	if !ok || repo == "" {
		return false, nil
	}
	switch args[0] {
	case "list":
		if len(opts.positionals) != 0 || opts.patch || opts.state != "" || opts.branch != "" || opts.workflow != "" || opts.status != "" || opts.author != "" || opts.assignee != "" || len(opts.labels) > 0 || !machineReadable(opts) || !supportedJSONFields(opts, supportedWorkflowFields) || limitOverOnePage(opts) {
			return false, nil
		}
		return true, relayWorkflowList(ctx, stdout, repo, opts)
	case "view":
		if len(opts.positionals) != 1 || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedWorkflowFields) || !supportedWorkflowRef(opts.positionals[0]) {
			return false, nil
		}
		return true, relayTop(ctx, stdout, ghAPIRequest{
			method:  "GET",
			path:    repoPath(repo, "actions", "workflows", opts.positionals[0]),
			headers: map[string]string{"x-octopool-public-shape": "workflow-view-v1"},
		}, opts, fieldMapWorkflow)
	default:
		return false, nil
	}
}

func runGHLabel(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	opts, fallback, err := parseGHTopOptions(args[1:])
	if err != nil || fallback {
		return !fallback, err
	}
	if topJQFallback(opts) {
		return false, nil
	}
	if args[0] != "list" || opts.patch || opts.state != "" || opts.branch != "" || opts.workflow != "" || opts.status != "" || opts.author != "" || opts.assignee != "" || len(opts.labels) > 0 || !machineReadable(opts) || !supportedJSONFields(opts, supportedLabelFields) || limitOverOnePage(opts) {
		return false, nil
	}
	repo, ok := repoOnly(opts)
	if !ok {
		return false, nil
	}
	return true, relayTop(ctx, stdout, ghAPIRequest{
		method:  "GET",
		path:    repoPath(repo, "labels"),
		query:   listQuery(opts),
		headers: map[string]string{"x-octopool-public-shape": "label-list-v1"},
	}, opts, fieldMapLabel)
}

func runGHGist(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	opts, fallback, err := parseGHTopOptions(args[1:])
	if err != nil || fallback {
		return !fallback, err
	}
	if topJQFallback(opts) {
		return false, nil
	}
	switch args[0] {
	case "list":
		return false, nil
	case "view":
		if len(opts.positionals) != 1 || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedGistFields) || !isHex(opts.positionals[0]) {
			return false, nil
		}
		return true, relayTop(ctx, stdout, ghAPIRequest{method: "GET", path: "/gists/" + opts.positionals[0]}, opts, fieldMapGist)
	default:
		return false, nil
	}
}
