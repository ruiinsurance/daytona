// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package common

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/daytonaio/runner/pkg/storageagent"
	"github.com/gin-gonic/gin"
)

func TestHandlePossibleDockerErrorMapsWrappedStorageAgentConflict(t *testing.T) {
	const (
		volumeID  = "57200000-0820-4720-8c00-000000000013"
		sandboxID = "57200000-0820-4720-8d00-000000000014"
	)
	root := t.TempDir()
	if err := storageagent.ObserveWorkspaceFence(root, volumeID, sandboxID, "2"); err != nil {
		t.Fatal(err)
	}
	stale := storageagent.ObserveWorkspaceFence(root, volumeID, sandboxID, "1")
	if stale == nil || !storageagent.IsConflict(stale) {
		t.Fatalf("stale fence error = %v, want storage-agent conflict", stale)
	}

	responseRecorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(responseRecorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/sandboxes/test/start", nil)
	response := HandlePossibleDockerError(ctx, fmt.Errorf("local-first start rejected: %w", stale))

	if response.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusConflict)
	}
	if response.Code != "CONFLICT" {
		t.Fatalf("code = %q, want CONFLICT", response.Code)
	}
	if !strings.Contains(response.Message, "stale_workspace_fence") {
		t.Fatalf("message = %q, want fixed stale fence category", response.Message)
	}
}

func TestHandlePossibleDockerErrorKeepsStorageAgentStateFailureInternal(t *testing.T) {
	const (
		volumeID  = "57200000-0820-4720-8c00-000000000013"
		sandboxID = "57200000-0820-4720-8d00-000000000014"
	)
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "fences"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(root, "fences", volumeID)); err != nil {
		t.Fatal(err)
	}
	stateFailure := storageagent.ObserveWorkspaceFence(root, volumeID, sandboxID, "2")
	if storageagent.Code(stateFailure) != "workspace_fence_state_unavailable" {
		t.Fatalf("state error = %q, want workspace_fence_state_unavailable", storageagent.Code(stateFailure))
	}
	if storageagent.IsConflict(stateFailure) {
		t.Fatal("unavailable fence state must not be a conflict")
	}

	responseRecorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(responseRecorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/sandboxes/test/start", nil)
	response := HandlePossibleDockerError(ctx, fmt.Errorf("local-first start rejected: %w", stateFailure))

	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusInternalServerError)
	}
	if !strings.Contains(response.Message, "workspace_fence_state_unavailable") {
		t.Fatalf("message = %q, want fixed unavailable-state category", response.Message)
	}
}
