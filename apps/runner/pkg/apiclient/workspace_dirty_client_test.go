// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package apiclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/daytonaio/runner/pkg/localfirst"
)

func TestWorkspaceDirtyClientUsesRunnerAuthAndFixedPayload(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/storage-nodes/11111111-1111-4111-8111-111111111111/workspaces/dirty" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer runner-token" {
			t.Fatalf("authorization header = %q", r.Header.Get("Authorization"))
		}
		if r.Header.Get(DaytonaSourceHeader) != "runner" {
			t.Fatalf("source header = %q", r.Header.Get(DaytonaSourceHeader))
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["volumeId"] != "22222222-2222-4222-8222-222222222222" ||
			body["sandboxId"] != "33333333-3333-4333-8333-333333333333" {
			t.Fatalf("payload = %#v", body)
		}
		if _, ok := body["workspacePath"]; ok {
			t.Fatalf("payload contains host path: %#v", body)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	defer server.Close()

	client := &WorkspaceDirtyClient{
		baseURL: server.URL,
		token:   "runner-token",
		client:  server.Client(),
	}
	err := client.MarkDirty(context.Background(), localfirst.DirtyEvent{
		NodeID:    "11111111-1111-4111-8111-111111111111",
		VolumeID:  "22222222-2222-4222-8222-222222222222",
		SandboxID: "33333333-3333-4333-8333-333333333333",
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestWorkspaceDirtyClientRedactsResponseBodyAndRejectsInvalidIdentity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"secret":"do-not-log","content":"user-data"}`))
	}))
	defer server.Close()

	client := &WorkspaceDirtyClient{baseURL: server.URL, token: "runner-token", client: server.Client()}
	err := client.MarkDirty(context.Background(), localfirst.DirtyEvent{
		NodeID:    "not-a-uuid",
		VolumeID:  "22222222-2222-4222-8222-222222222222",
		SandboxID: "33333333-3333-4333-8333-333333333333",
	})
	if err == nil || !strings.Contains(err.Error(), "workspace_dirty_request_invalid") {
		t.Fatalf("error = %v, want fixed validation category", err)
	}

	err = client.MarkDirty(context.Background(), localfirst.DirtyEvent{
		NodeID:    "11111111-1111-4111-8111-111111111111",
		VolumeID:  "22222222-2222-4222-8222-222222222222",
		SandboxID: "33333333-3333-4333-8333-333333333333",
	})
	if err == nil || !strings.Contains(err.Error(), "workspace_dirty_request_rejected") {
		t.Fatalf("error = %v, want fixed rejection category", err)
	}
	if strings.Contains(err.Error(), "do-not-log") || strings.Contains(err.Error(), "user-data") {
		t.Fatalf("error leaked response body: %v", err)
	}
}
