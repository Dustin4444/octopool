package main

import (
	"context"
	"io"
)

func runGHPR(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
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
		repo, number, ok := repoNumber(opts)
		if !ok || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedPRFields) {
			return false, nil
		}
		if needsHydratedPR(opts.json) {
			return true, relayHydratedPRView(ctx, stdout, repo, number, opts)
		}
		return true, relayTop(ctx, stdout, ghAPIRequest{
			method:  "GET",
			path:    repoPath(repo, "pulls", number),
			headers: publicShapeHeaders(opts, supportedPublicPRViewFields, "pr-summary-v1"),
		}, opts, fieldMapPR)
	case "list":
		repo, ok := repoOnly(opts)
		if !ok || !machineReadable(opts) || !supportedJSONFields(opts, supportedPRListFields) || !supportedPRListState(opts.state) || limitOverOnePage(opts) || opts.author != "" || opts.assignee != "" || len(opts.labels) > 0 {
			return false, nil
		}
		query := listQuery(opts)
		if opts.state != "" {
			query["state"] = opts.state
		}
		return true, relayTop(ctx, stdout, ghAPIRequest{
			method:  "GET",
			path:    repoPath(repo, "pulls"),
			query:   query,
			headers: publicShapeHeaders(opts, supportedPublicPRListFields, "pr-list-v1"),
		}, opts, fieldMapPR)
	case "diff":
		repo, number, ok := repoNumber(opts)
		if !ok || hasTopModifiersExceptPatch(opts) || machineReadable(opts) || opts.jq != "" {
			return false, nil
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
		return true, relayTop(ctx, stdout, request, ghTopOptions{}, nil)
	case "checks":
		repo, number, ok := repoNumber(opts)
		if !ok || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedCheckRunFields) {
			return false, nil
		}
		return true, relayPRChecks(ctx, stdout, repo, number, opts)
	default:
		return false, nil
	}
}
