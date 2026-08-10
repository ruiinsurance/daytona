// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package docker

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	runnerconfig "github.com/daytonaio/runner/cmd/runner/config"
	"github.com/docker/docker/client"
)

var initializeTestRunnerConfig sync.Once

func requireTestRunnerConfig(t *testing.T) {
	t.Helper()

	initializeTestRunnerConfig.Do(func() {
		t.Setenv("ENVIRONMENT", "development")
		t.Setenv("DAYTONA_API_URL", "http://api.test")
		t.Setenv("DAYTONA_RUNNER_TOKEN", "test-token")
		t.Setenv("RUNNER_DOMAIN", "runner.test")
		if _, err := runnerconfig.GetConfig(); err != nil {
			t.Fatalf("initialize Runner config: %v", err)
		}
	})
}

func writeFakeCommand(t *testing.T, dir, name, body string) {
	t.Helper()

	path := filepath.Join(dir, name)
	contents := "#!/bin/sh\nset -eu\n" + body + "\n"
	if err := os.WriteFile(path, []byte(contents), 0o755); err != nil {
		t.Fatalf("write fake %s: %v", name, err)
	}
}

func installMountFailureCommands(t *testing.T, mountpointStatus int) {
	t.Helper()

	binDir := t.TempDir()
	writeFakeCommand(t, binDir, "mountpoint", fmt.Sprintf("exit %d", mountpointStatus))
	writeFakeCommand(t, binDir, "umount", "exit 0")
	writeFakeCommand(t, binDir, "mount-s3", "exit 42")
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func newStoppedContainerClient(t *testing.T, sandboxID string, startCalls *atomic.Int32) *client.Client {
	t.Helper()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.51/containers/" + sandboxID + "/json":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{
  "Id": "`+sandboxID+`",
  "State": {"Status": "exited", "Running": false, "ExitCode": 0},
  "Config": {"Entrypoint": ["/usr/local/bin/daytona-daemon"], "WorkingDir": ""},
  "NetworkSettings": {"Networks": {}}
}`)
		case "/v1.51/containers/" + sandboxID + "/start":
			startCalls.Add(1)
			http.Error(w, "ContainerStart must not be called", http.StatusInternalServerError)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	apiClient, err := client.NewClientWithOpts(
		client.WithHost(server.URL),
		client.WithHTTPClient(server.Client()),
		client.WithVersion("1.51"),
	)
	if err != nil {
		t.Fatalf("create Docker API client: %v", err)
	}
	t.Cleanup(func() { _ = apiClient.Close() })
	return apiClient
}

func newStartTestDockerClient(apiClient client.APIClient) *DockerClient {
	return &DockerClient{
		apiClient:          apiClient,
		logger:             slog.New(slog.NewTextHandler(io.Discard, nil)),
		awsRegion:          "us-east-1",
		awsEndpointUrl:     "http://minio.test:9000",
		awsAccessKeyId:     "test-access-key",
		awsSecretAccessKey: "test-secret-key",
		volumeMutexes:      make(map[string]*sync.Mutex),
	}
}

func TestStartFailsClosedWhenVolumeRemountFails(t *testing.T) {
	requireTestRunnerConfig(t)
	installMountFailureCommands(t, 1)

	const sandboxID = "sandbox-remount-failure"
	var startCalls atomic.Int32
	dockerClient := newStartTestDockerClient(newStoppedContainerClient(t, sandboxID, &startCalls))
	subpath := "sandboxes/" + sandboxID + "/workspace"
	metadata := map[string]string{
		"volumes": `[{"volumeId":"` + testVolumeID + `","mountPath":"/workspace","subpath":"` + subpath + `"}]`,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _, err := dockerClient.Start(ctx, sandboxID, nil, metadata)
	if err == nil || !strings.Contains(err.Error(), "failed to mount S3 volume") {
		t.Fatalf("Start() error = %v, want the volume remount error", err)
	}
	if got := startCalls.Load(); got != 0 {
		t.Fatalf("ContainerStart calls = %d, want 0 after volume remount failure", got)
	}
}

func TestStartFailsClosedWhenPersistedVolumeMetadataIsMalformed(t *testing.T) {
	requireTestRunnerConfig(t)

	const sandboxID = "sandbox-invalid-volume-metadata"
	var startCalls atomic.Int32
	dockerClient := newStartTestDockerClient(newStoppedContainerClient(t, sandboxID, &startCalls))

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _, err := dockerClient.Start(ctx, sandboxID, nil, map[string]string{"volumes": "not-json"})
	if err == nil || !strings.Contains(err.Error(), "invalid persisted volume metadata") {
		t.Fatalf("Start() error = %v, want an invalid persisted volume metadata error", err)
	}
	if got := startCalls.Load(); got != 0 {
		t.Fatalf("ContainerStart calls = %d, want 0 for malformed volume metadata", got)
	}
}

func TestEnsureVolumeFuseMountedRejectsUnresponsiveExistingMount(t *testing.T) {
	requireTestRunnerConfig(t)
	installMountFailureCommands(t, 0)

	mountPath := filepath.Join(os.TempDir(), volumeMountPrefix+testVolumeID)
	if err := os.RemoveAll(mountPath); err != nil {
		t.Fatalf("remove stale test mount path: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(mountPath) })

	dockerClient := newStartTestDockerClient(nil)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := dockerClient.ensureVolumeFuseMounted(ctx, testVolumeID, mountPath)
	if err == nil {
		t.Fatal("ensureVolumeFuseMounted() accepted a registered mount whose path is unreadable")
	}
}

func TestEnsureVolumeFuseMountedAcceptsResponsiveExistingMount(t *testing.T) {
	requireTestRunnerConfig(t)
	installMountFailureCommands(t, 0)

	mountPath := filepath.Join(os.TempDir(), volumeMountPrefix+testVolumeID)
	if err := os.RemoveAll(mountPath); err != nil {
		t.Fatalf("remove previous test mount path: %v", err)
	}
	if err := os.MkdirAll(mountPath, 0o755); err != nil {
		t.Fatalf("create responsive test mount path: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(mountPath) })

	dockerClient := newStartTestDockerClient(nil)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := dockerClient.ensureVolumeFuseMounted(ctx, testVolumeID, mountPath); err != nil {
		t.Fatalf("ensureVolumeFuseMounted() rejected a responsive existing mount: %v", err)
	}
}
