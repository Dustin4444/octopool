package main

import (
	"encoding/json"
	"testing"
)

func TestFilterJSONFieldsUsesGHNames(t *testing.T) {
	raw := []byte(`{"number":85341,"title":"fix","html_url":"https://example.test/pr","head":{"ref":"feature","sha":"abc1234"},"draft":true}`)
	out, err := filterJSONFields(raw, []string{"number", "url", "headRefName", "headRefOid", "isDraft"}, fieldMapPR)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got["url"] != "https://example.test/pr" || got["headRefName"] != "feature" || got["headRefOid"] != "abc1234" || got["isDraft"] != true {
		t.Fatalf("filtered = %#v", got)
	}
}
