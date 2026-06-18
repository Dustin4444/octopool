package main

import (
	"context"
	"io"
)

func runGHRun(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
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
		if !ok {
			return false, nil
		}
		query := listQueryDefault(opts, 20)
		if opts.branch != "" {
			query["branch"] = opts.branch
		}
		if opts.status != "" {
			query["status"] = opts.status
		}
		path := repoPath(repo, "actions", "runs")
		if opts.workflow != "" {
			if !supportedWorkflowRef(opts.workflow) {
				return false, nil
			}
			path = repoPath(repo, "actions", "workflows", opts.workflow, "runs")
		}
		if !machineReadable(opts) || !supportedJSONFields(opts, supportedRunListFields) || limitOverOnePage(opts) {
			return false, nil
		}
		return true, relayTop(ctx, stdout, ghAPIRequest{
			method:  "GET",
			path:    path,
			query:   query,
			headers: map[string]string{"x-octopool-public-shape": "actions-summary-v1"},
		}, opts, fieldMapRun)
	case "view":
		if len(opts.positionals) != 1 || !isDigits(opts.positionals[0]) || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedRunViewFields) {
			return false, nil
		}
		repo, ok := repoFromOptionOrCurrent(opts.repo)
		if !ok {
			return false, nil
		}
		return true, relayRunView(ctx, stdout, repo, opts.positionals[0], opts)
	default:
		return false, nil
	}
}
