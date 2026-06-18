package main

import (
	"context"
	"io"
)

func runGHPR(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	return legacyGHResult(handleGHPR(ctx, args, stdout))
}

func runGHIssue(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	return legacyGHResult(handleGHIssue(ctx, args, stdout))
}

func runGHRun(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	return legacyGHResult(handleGHRun(ctx, args, stdout))
}

func runGHRepo(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	return legacyGHResult(handleGHRepo(ctx, args, stdout))
}

func runGHRelease(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	return legacyGHResult(handleGHRelease(ctx, args, stdout))
}

func runGHWorkflow(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	return legacyGHResult(handleGHWorkflow(ctx, args, stdout))
}

func runGHLabel(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	return legacyGHResult(handleGHLabel(ctx, args, stdout))
}

func runGHGist(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	return legacyGHResult(handleGHGist(ctx, args, stdout))
}

func runGHSearch(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	return legacyGHResult(handleGHSearch(ctx, args, stdout))
}

func legacyGHResult(result ghResult) (bool, error) {
	switch result.action {
	case ghComplete:
		return true, nil
	case ghFail:
		return true, result.err
	default:
		return false, nil
	}
}
