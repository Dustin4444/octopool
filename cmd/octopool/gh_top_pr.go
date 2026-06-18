package main

import (
	"context"
	"io"
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
