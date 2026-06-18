package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

var httpClient = &http.Client{Timeout: 30 * time.Second}

func getJSON(ctx context.Context, stdout io.Writer, url string, token string) error {
	resp, err := getJSONRaw(ctx, url, token)
	if err != nil {
		return err
	}
	return writeJSONResponse(stdout, resp)
}

func getJSONRaw(ctx context.Context, url string, token string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("authorization", "Bearer "+token)
	return httpClient.Do(req)
}

func postJSON(ctx context.Context, stdout io.Writer, url string, token string, body map[string]any) error {
	resp, err := postJSONRaw(ctx, url, token, body)
	if err != nil {
		return err
	}
	return writeJSONResponse(stdout, resp)
}

func postJSONRaw(
	ctx context.Context,
	url string,
	token string,
	body map[string]any,
) (*http.Response, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(encoded)))
	if err != nil {
		return nil, err
	}
	if token != "" {
		req.Header.Set("authorization", "Bearer "+token)
	}
	req.Header.Set("content-type", "application/json")
	return httpClient.Do(req)
}

func writeJSONResponse(stdout io.Writer, resp *http.Response) error {
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return err
	}
	encoder := json.NewEncoder(stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func doRaw(ctx context.Context, url string, token string, body map[string]any) ([]byte, int, error) {
	resp, err := postJSONRaw(ctx, url, token, body)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return out, resp.StatusCode, nil
}
