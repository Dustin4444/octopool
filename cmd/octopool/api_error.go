package main

type apiErrorResponse struct {
	Error struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		RequestID string `json:"request_id"`
		Details   struct {
			GitHubRateLimitReset     string `json:"github_rate_limit_reset"`
			GitHubRateLimitRemaining string `json:"github_rate_limit_remaining"`
			GitHubRateLimitResource  string `json:"github_rate_limit_resource"`
			GitHubRetryAfter         string `json:"github_retry_after"`
			FallbackReason           string `json:"reason"`
		} `json:"details"`
	} `json:"error"`
}
