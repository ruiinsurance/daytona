// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package docker

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/daytonaio/runner/pkg/api/dto"
	"github.com/docker/docker/client"
)

func TestContainerDiskResizeRollsBackLocalMountMismatch(t *testing.T) {
	const sandboxID = "22222222-2222-4222-8222-222222222222"
	subpath := "sandboxes/" + sandboxID + "/workspace"
	root := t.TempDir()
	bindSource := filepath.Join(root, volumeMountPrefix+testVolumeID, filepath.FromSlash(subpath))
	volumes := []dto.VolumeDTO{
		{VolumeId: testVolumeID, MountPath: "/workspace", Subpath: &subpath, Backend: localVolumeBackend},
		{VolumeId: testVolumeID, MountPath: "/config", Subpath: &subpath, Backend: localVolumeBackend},
	}

	var inspectCalls atomic.Int32
	var replacementRemoveCalls atomic.Int32
	var rollbackRenameCalls atomic.Int32
	var originalRename string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1.51/containers/"+sandboxID+"/json":
			call := inspectCalls.Add(1)
			configSource := bindSource
			if call > 1 {
				configSource += "-wrong"
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprintf(w, `{
  "Id": %q,
  "Name": %q,
  "Image": "sha256:test-image",
  "State": {"Status": "exited", "Running": false, "ExitCode": 0},
  "Config": {"Image": "test-image:latest", "Entrypoint": ["/usr/local/bin/daytona-daemon"]},
  "HostConfig": {"Binds": [%q, %q], "StorageOpt": {"size": "3221225472"}},
  "GraphDriver": {"Name": "overlay2", "Data": {}},
  "Mounts": [
    {"Type": "bind", "Source": %q, "Destination": "/workspace"},
    {"Type": "bind", "Source": %q, "Destination": "/config"}
  ],
  "NetworkSettings": {"Networks": {}}
}`, sandboxID, "/"+sandboxID, bindSource+":/workspace", bindSource+":/config", bindSource, configSource)
		case r.Method == http.MethodGet && r.URL.Path == "/v1.51/images/test-image:latest/json":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"Id":"sha256:test-image","RepoTags":["test-image:latest"]}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1.51/containers/"+sandboxID+"/rename":
			originalRename = r.URL.Query().Get("name")
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/v1.51/containers/create":
			if r.URL.Query().Get("name") != sandboxID {
				http.Error(w, "unexpected replacement name", http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprintf(w, `{"Id":%q,"Warnings":[]}`, sandboxID)
		case r.Method == http.MethodDelete && r.URL.Path == "/v1.51/containers/"+sandboxID:
			replacementRemoveCalls.Add(1)
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/v1.51/containers/"+url.PathEscape(originalRename)+"/rename"):
			if r.URL.Query().Get("name") == sandboxID {
				rollbackRenameCalls.Add(1)
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "unexpected Docker request: "+r.Method+" "+r.URL.String(), http.StatusNotFound)
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

	dockerClient := newStartTestDockerClient(apiClient)
	dockerClient.filesystem = "xfs"
	dockerClient.localVolumeEnabled = true
	dockerClient.localVolumeRoot = root

	err = dockerClient.ContainerDiskResize(
		context.Background(),
		sandboxID,
		5,
		0,
		0,
		"resize",
		nil,
		volumes,
	)
	if err == nil || !strings.Contains(err.Error(), "verify local mounts after resize replacement") {
		t.Fatalf("ContainerDiskResize() error = %v, want post-replacement local mount verification failure", err)
	}
	if inspectCalls.Load() != 2 {
		t.Fatalf("container inspect calls = %d, want original and replacement inspections", inspectCalls.Load())
	}
	if replacementRemoveCalls.Load() != 1 {
		t.Fatalf("replacement remove calls = %d, want 1", replacementRemoveCalls.Load())
	}
	if rollbackRenameCalls.Load() != 1 {
		t.Fatalf("rollback rename calls = %d, want 1", rollbackRenameCalls.Load())
	}
}
