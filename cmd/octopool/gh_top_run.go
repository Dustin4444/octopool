package main

import (
	"context"
	"io"
)

func handleGHRun(ctx context.Context, args []string, stdout io.Writer) ghResult {
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
		if !ok {
			return ghDelegated()
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
				return ghDelegated()
			}
			path = repoPath(repo, "actions", "workflows", opts.workflow, "runs")
		}
		if !machineReadable(opts) || !supportedJSONFields(opts, supportedRunListFields) || limitOverOnePage(opts) {
			return ghDelegated()
		}
		return ghCompleted(relayTop(ctx, stdout, ghAPIRequest{
			method:  "GET",
			path:    path,
			query:   query,
			headers: map[string]string{"x-octopool-public-shape": "actions-summary-v1"},
		}, opts, fieldMapRun))
	case "view":
		if len(opts.positionals) != 1 || !isDigits(opts.positionals[0]) || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedRunViewFields) {
			return ghDelegated()
		}
		repo, ok := repoFromOptionOrCurrent(opts.repo)
		if !ok {
			return ghDelegated()
		}
		return ghCompleted(relayRunView(ctx, stdout, repo, opts.positionals[0], opts))
	default:
		return ghDelegated()
	}
}
