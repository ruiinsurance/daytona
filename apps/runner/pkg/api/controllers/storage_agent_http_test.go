// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package controllers_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	commonErrors "github.com/daytonaio/common-go/pkg/errors"
	"github.com/daytonaio/runner/pkg/api/controllers"
	"github.com/daytonaio/runner/pkg/api/middlewares"
	common "github.com/daytonaio/runner/pkg/common"
	"github.com/daytonaio/runner/pkg/runner"
	"github.com/daytonaio/runner/pkg/storageagent"
	"github.com/gin-gonic/gin"
)

const (
	httpTestToken     = "storage-agent-test-token"
	httpTestNodeID    = "11111111-1111-4111-8111-111111111111"
	httpTestVolumeID  = "22222222-2222-4222-8222-222222222222"
	httpTestSandboxID = "33333333-3333-4333-8333-333333333333"
	httpTestOperation = "44444444-4444-4444-8444-444444444444"
)

func TestStorageAgentHTTPContract(t *testing.T) {
	gin.SetMode(gin.TestMode)
	root := t.TempDir()
	agent, err := storageagent.New(storageagent.Config{Root: root, NodeID: httpTestNodeID})
	if err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(root, "nodes", httpTestNodeID, "volumes", httpTestVolumeID, "sandboxes", httpTestSandboxID, "workspace")
	if err := os.MkdirAll(workspace, 0o770); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "state.db"), []byte("state"), 0o660); err != nil {
		t.Fatal(err)
	}
	if _, err := runner.GetInstance(&runner.RunnerInstanceConfig{StorageAgent: agent}); err != nil {
		t.Fatal(err)
	}

	router := gin.New()
	router.Use(commonErrors.NewErrorMiddleware(common.HandlePossibleDockerError))
	protected := router.Group("/")
	protected.Use(middlewares.AuthMiddleware(httpTestToken))
	protected.POST("/storage/workspaces/checkpoint", controllers.CheckpointWorkspace)
	protected.POST("/storage/workspaces/export", controllers.ExportWorkspaceCheckpoint)
	protected.POST("/storage/workspaces/verify", controllers.VerifyWorkspaceCheckpoint)
	protected.POST("/storage/workspaces/quiesce", controllers.QuiesceWorkspace)
	protected.POST("/storage/workspaces/retain", controllers.RetainWorkspaceSource)

	t.Run("rejects missing and invalid bearer credentials", func(t *testing.T) {
		for name, authorization := range map[string]string{
			"missing": "",
			"wrong":   "Bearer wrong-token",
		} {
			t.Run(name, func(t *testing.T) {
				request := httptest.NewRequest(http.MethodPost, "/storage/workspaces/checkpoint", bytes.NewBufferString("{}"))
				if authorization != "" {
					request.Header.Set("Authorization", authorization)
				}
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)
				if response.Code != http.StatusUnauthorized {
					t.Fatalf("status = %d, want %d", response.Code, http.StatusUnauthorized)
				}
			})
		}
	})

	leaseExpiresAt := time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	baseRequest := map[string]any{
		"operationId":    httpTestOperation,
		"volumeId":       httpTestVolumeID,
		"sandboxId":      httpTestSandboxID,
		"nodeId":         httpTestNodeID,
		"fenceEpoch":     "7",
		"leaseOwner":     "move-worker:" + httpTestOperation,
		"leaseExpiresAt": leaseExpiresAt,
	}

	checkpointBody := cloneMap(baseRequest)
	checkpointBody["generation"] = "1"
	checkpointResponse := postJSON(t, router, "/storage/workspaces/checkpoint", checkpointBody)
	if checkpointResponse.Code != http.StatusOK {
		t.Fatalf("checkpoint status = %d, body = %s", checkpointResponse.Code, checkpointResponse.Body.String())
	}
	var checkpoint storageagent.Checkpoint
	decodeJSON(t, checkpointResponse, &checkpoint)

	exportBody := cloneMap(checkpointBody)
	exportResponse := postJSON(t, router, "/storage/workspaces/export", exportBody)
	if exportResponse.Code != http.StatusOK {
		t.Fatalf("export status = %d, body = %s", exportResponse.Code, exportResponse.Body.String())
	}

	verifyBody := cloneMap(baseRequest)
	verifyBody["generation"] = checkpoint.Generation
	verifyBody["manifest"] = checkpoint.Manifest
	verifyResponse := postJSON(t, router, "/storage/workspaces/verify", verifyBody)
	if verifyResponse.Code != http.StatusOK {
		t.Fatalf("verify status = %d, body = %s", verifyResponse.Code, verifyResponse.Body.String())
	}
	var verified storageagent.VerifyResponse
	decodeJSON(t, verifyResponse, &verified)
	if verified.Generation != checkpoint.Generation || len(verified.ManifestHash) != 64 {
		t.Fatalf("unexpected verify response: %#v", verified)
	}

	quiesceResponse := postJSON(t, router, "/storage/workspaces/quiesce", baseRequest)
	if quiesceResponse.Code != http.StatusOK {
		t.Fatalf("quiesce status = %d, body = %s", quiesceResponse.Code, quiesceResponse.Body.String())
	}
	retainBody := cloneMap(baseRequest)
	retainBody["generation"] = checkpoint.Generation
	retainResponse := postJSON(t, router, "/storage/workspaces/retain", retainBody)
	if retainResponse.Code != http.StatusOK {
		t.Fatalf("retain status = %d, body = %s", retainResponse.Code, retainResponse.Body.String())
	}

	malformed := httptest.NewRequest(http.MethodPost, "/storage/workspaces/checkpoint", bytes.NewBufferString("not-json"))
	malformed.Header.Set("Authorization", "Bearer "+httpTestToken)
	malformedResponse := httptest.NewRecorder()
	router.ServeHTTP(malformedResponse, malformed)
	if malformedResponse.Code != http.StatusBadRequest {
		t.Fatalf("malformed status = %d, want %d", malformedResponse.Code, http.StatusBadRequest)
	}
}

func postJSON(t *testing.T, router http.Handler, path string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(encoded))
	request.Header.Set("Authorization", "Bearer "+httpTestToken)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func decodeJSON(t *testing.T, response *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(response.Body.Bytes(), target); err != nil {
		t.Fatalf("decode response: %v; body = %s", err, response.Body.String())
	}
}

func cloneMap(input map[string]any) map[string]any {
	clone := make(map[string]any, len(input))
	for key, value := range input {
		clone[key] = value
	}
	return clone
}
