package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

type relayEnvelope struct {
	Status       int             `json:"status"`
	Body         json.RawMessage `json:"body"`
	BodyEncoding string          `json:"body_encoding"`
}

var errOctopoolNotLoggedIn = errors.New("not logged in; run: octopool login")

type ghRelayClient struct {
	token   string
	baseURL string
	pool    string
}

func newGHRelayClient() (ghRelayClient, error) {
	auth, err := loadAuth()
	if err != nil {
		return ghRelayClient{}, err
	}
	token := strings.TrimSpace(os.Getenv("OCTOPOOL_TOKEN"))
	if token == "" {
		token = auth.Token
	}
	if token == "" {
		return ghRelayClient{}, errOctopoolNotLoggedIn
	}
	baseURL := envDefault("OCTOPOOL_URL", auth.URL)
	if baseURL == "" {
		baseURL = defaultURL
	}
	if err := validateAuthURLForRequest(auth, baseURL, "OCTOPOOL_TOKEN"); err != nil {
		return ghRelayClient{}, err
	}
	pool := envDefault("OCTOPOOL_POOL", auth.Pool)
	if pool == "" {
		pool = "maintainers"
	}
	return ghRelayClient{token: token, baseURL: baseURL, pool: pool}, nil
}

func (client ghRelayClient) do(ctx context.Context, request ghAPIRequest) (relayEnvelope, error) {
	body := map[string]any{
		"pool":   client.pool,
		"method": request.method,
		"path":   request.path,
	}
	if len(request.query) > 0 {
		body["query"] = request.query
	}
	if len(request.headers) > 0 {
		body["headers"] = request.headers
	}
	out, status, err := doRaw(ctx, apiURL(client.baseURL, "/v1/github/request"), client.token, body)
	if err != nil {
		return relayEnvelope{}, err
	}
	if status >= 400 {
		if fallback, ok := parseAuthFallback(out); ok {
			return relayEnvelope{}, fallback
		}
		if fallback, ok := parseLocalFallback(out); ok {
			return relayEnvelope{}, fallback
		}
		return relayEnvelope{}, fmt.Errorf("octopool request failed: %s", strings.TrimSpace(string(out)))
	}
	var envelope relayEnvelope
	if err := json.Unmarshal(out, &envelope); err != nil {
		return relayEnvelope{}, err
	}
	return envelope, nil
}

func decodeRelayBody(envelope relayEnvelope) ([]byte, error) {
	switch envelope.BodyEncoding {
	case "json":
		return append([]byte(nil), envelope.Body...), nil
	case "text":
		if rawJSONIsNull(envelope.Body) {
			return nil, nil
		}
		var text string
		if err := json.Unmarshal(envelope.Body, &text); err != nil {
			return nil, err
		}
		return []byte(text), nil
	case "base64":
		if rawJSONIsNull(envelope.Body) {
			return nil, nil
		}
		var encoded string
		if err := json.Unmarshal(envelope.Body, &encoded); err != nil {
			return nil, err
		}
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, err
		}
		return decoded, nil
	default:
		return nil, fmt.Errorf("unsupported relay body encoding %q", envelope.BodyEncoding)
	}
}

func writeGHBody(ctx context.Context, stdout io.Writer, envelope relayEnvelope, jq string) error {
	out, err := decodeRelayBody(envelope)
	if err != nil {
		return err
	}
	if envelope.Status >= 400 {
		_, _ = stdout.Write(out)
		return fmt.Errorf("github returned status %d", envelope.Status)
	}
	return writeBytes(ctx, stdout, out, jq)
}

func rawJSONIsNull(value json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(value), []byte("null"))
}
