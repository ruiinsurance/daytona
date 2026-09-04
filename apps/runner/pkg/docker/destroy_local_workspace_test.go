// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package docker

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	dockerclient "github.com/docker/docker/client"
)

const (
	destroyWorkspaceSandboxID = "11111111-1111-4111-8111-111111111111"
	destroyWorkspaceSiblingID = "22222222-2222-4222-8222-222222222222"
	destroyWorkspaceVolumeID  = "33333333-3333-4333-8333-333333333333"
)

func TestRemoveLocalWorkspaceDeletesOnlyExactSandboxSlice(t *testing.T) {
	root := trustedTempRoot(t)
	target := localWorkspaceTestPath(root, destroyWorkspaceVolumeID, destroyWorkspaceSandboxID)
	sibling := localWorkspaceTestPath(root, destroyWorkspaceVolumeID, destroyWorkspaceSiblingID)
	volumeSentinel := filepath.Join(root, volumeMountPrefix+destroyWorkspaceVolumeID, "volume-sentinel")

	mustWriteTestFile(t, filepath.Join(target, "target.txt"))
	mustWriteTestFile(t, filepath.Join(sibling, "sibling.txt"))
	mustWriteTestFile(t, volumeSentinel)

	outcome, err := removeLocalWorkspace(
		root,
		destroyWorkspaceSandboxID,
		destroyWorkspaceVolumeID,
		"sandboxes/"+destroyWorkspaceSandboxID+"/workspace",
		nil,
	)
	if err != nil {
		t.Fatalf("remove exact workspace: %v", err)
	}
	if outcome != localWorkspaceRemoved {
		t.Fatalf("unexpected outcome: %q", outcome)
	}
	if _, err := os.Lstat(target); !os.IsNotExist(err) {
		t.Fatalf("target workspace still exists or returned unexpected error: %v", err)
	}
	if _, err := os.Stat(filepath.Join(sibling, "sibling.txt")); err != nil {
		t.Fatalf("sibling workspace was changed: %v", err)
	}
	if _, err := os.Stat(volumeSentinel); err != nil {
		t.Fatalf("shared volume root was changed: %v", err)
	}
}

func TestRemoveLocalWorkspaceIsIdempotentWhenExactSliceIsAbsent(t *testing.T) {
	root := trustedTempRoot(t)
	mustWriteTestFile(t, filepath.Join(root, volumeMountPrefix+destroyWorkspaceVolumeID, "volume-sentinel"))

	outcome, err := removeLocalWorkspace(
		root,
		destroyWorkspaceSandboxID,
		destroyWorkspaceVolumeID,
		"sandboxes/"+destroyWorkspaceSandboxID+"/workspace",
		nil,
	)
	if err != nil {
		t.Fatalf("replay absent workspace removal: %v", err)
	}
	if outcome != localWorkspaceAlreadyAbsent {
		t.Fatalf("unexpected replay outcome: %q", outcome)
	}
}

func TestRemoveLocalWorkspaceRejectsIdentityAndMountConflicts(t *testing.T) {
	root := trustedTempRoot(t)
	target := localWorkspaceTestPath(root, destroyWorkspaceVolumeID, destroyWorkspaceSandboxID)
	mustWriteTestFile(t, filepath.Join(target, "target.txt"))

	tests := []struct {
		name         string
		subpath      string
		activeMounts []string
	}{
		{
			name:    "another sandbox subpath",
			subpath: "sandboxes/" + destroyWorkspaceSiblingID + "/workspace",
		},
		{
			name:         "exact workspace is mounted",
			subpath:      "sandboxes/" + destroyWorkspaceSandboxID + "/workspace",
			activeMounts: []string{target},
		},
		{
			name:         "workspace descendant is mounted",
			subpath:      "sandboxes/" + destroyWorkspaceSandboxID + "/workspace",
			activeMounts: []string{filepath.Join(target, "nested")},
		},
		{
			name:         "workspace ancestor is mounted",
			subpath:      "sandboxes/" + destroyWorkspaceSandboxID + "/workspace",
			activeMounts: []string{filepath.Dir(target)},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := removeLocalWorkspace(
				root,
				destroyWorkspaceSandboxID,
				destroyWorkspaceVolumeID,
				test.subpath,
				test.activeMounts,
			); err == nil {
				t.Fatal("expected fail-closed workspace removal")
			}
			if _, err := os.Stat(filepath.Join(target, "target.txt")); err != nil {
				t.Fatalf("target changed after rejected request: %v", err)
			}
		})
	}
}

func TestRemoveLocalWorkspaceRejectsSymlinkAncestor(t *testing.T) {
	root := trustedTempRoot(t)
	outside := trustedTempRoot(t)
	volumeRoot := filepath.Join(root, volumeMountPrefix+destroyWorkspaceVolumeID)
	if err := os.MkdirAll(volumeRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(volumeRoot, "sandboxes")); err != nil {
		t.Fatal(err)
	}

	if _, err := removeLocalWorkspace(
		root,
		destroyWorkspaceSandboxID,
		destroyWorkspaceVolumeID,
		"sandboxes/"+destroyWorkspaceSandboxID+"/workspace",
		nil,
	); err == nil {
		t.Fatal("expected symlink ancestor rejection")
	}
}

func TestDestroyLocalWorkspaceRejectsExistingSandboxCompute(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1.51/containers/"+destroyWorkspaceSandboxID+"/json" {
			http.NotFound(w, request)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"Id":"`+destroyWorkspaceSandboxID+`","State":{"Status":"exited"}}`)
	}))
	t.Cleanup(server.Close)
	apiClient, err := dockerclient.NewClientWithOpts(
		dockerclient.WithHost(server.URL),
		dockerclient.WithHTTPClient(server.Client()),
		dockerclient.WithVersion("1.51"),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = apiClient.Close() })
	client := &DockerClient{apiClient: apiClient, localVolumeRoot: trustedTempRoot(t)}

	if _, err := client.DestroyLocalWorkspace(
		context.Background(),
		destroyWorkspaceSandboxID,
		destroyWorkspaceVolumeID,
		"sandboxes/"+destroyWorkspaceSandboxID+"/workspace",
	); err == nil {
		t.Fatal("expected existing sandbox compute rejection")
	}
}

func TestValidateLocalWorkspaceForRecoveryRequiresExactNonEmptySlice(t *testing.T) {
	root := trustedTempRoot(t)
	target := localWorkspaceTestPath(root, destroyWorkspaceVolumeID, destroyWorkspaceSandboxID)
	mustWriteTestFile(t, filepath.Join(target, "restored.txt"))

	if err := validateLocalWorkspaceForRecovery(
		root,
		destroyWorkspaceSandboxID,
		destroyWorkspaceVolumeID,
		"sandboxes/"+destroyWorkspaceSandboxID+"/workspace",
		nil,
	); err != nil {
		t.Fatalf("validate restored workspace: %v", err)
	}

	if err := validateLocalWorkspaceForRecovery(
		root,
		destroyWorkspaceSandboxID,
		destroyWorkspaceVolumeID,
		"sandboxes/"+destroyWorkspaceSiblingID+"/workspace",
		nil,
	); err == nil {
		t.Fatal("expected another sandbox subpath rejection")
	}
	if err := validateLocalWorkspaceForRecovery(
		root,
		destroyWorkspaceSandboxID,
		destroyWorkspaceVolumeID,
		"sandboxes/"+destroyWorkspaceSandboxID+"/workspace",
		[]string{target},
	); err == nil {
		t.Fatal("expected mounted replacement rejection")
	}
}

func TestValidateLocalWorkspaceForRecoveryRejectsEmptySlice(t *testing.T) {
	root := trustedTempRoot(t)
	target := localWorkspaceTestPath(root, destroyWorkspaceVolumeID, destroyWorkspaceSandboxID)
	if err := os.MkdirAll(target, 0o750); err != nil {
		t.Fatal(err)
	}

	if err := validateLocalWorkspaceForRecovery(
		root,
		destroyWorkspaceSandboxID,
		destroyWorkspaceVolumeID,
		"sandboxes/"+destroyWorkspaceSandboxID+"/workspace",
		nil,
	); err == nil {
		t.Fatal("expected empty replacement rejection")
	}
}

func TestProbeLocalWorkspaceMissingDistinguishesAbsentFromAvailable(t *testing.T) {
	root := trustedTempRoot(t)
	subpath := "sandboxes/" + destroyWorkspaceSandboxID + "/workspace"
	missing, err := probeLocalWorkspaceMissing(
		root,
		destroyWorkspaceSandboxID,
		destroyWorkspaceVolumeID,
		subpath,
		nil,
	)
	if err != nil || !missing {
		t.Fatalf("expected missing original workspace, missing=%t err=%v", missing, err)
	}

	mustWriteTestFile(t, filepath.Join(localWorkspaceTestPath(root, destroyWorkspaceVolumeID, destroyWorkspaceSandboxID), "live.txt"))
	missing, err = probeLocalWorkspaceMissing(
		root,
		destroyWorkspaceSandboxID,
		destroyWorkspaceVolumeID,
		subpath,
		nil,
	)
	if err != nil || missing {
		t.Fatalf("expected available original workspace, missing=%t err=%v", missing, err)
	}
}

func trustedTempRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func localWorkspaceTestPath(root, volumeID, sandboxID string) string {
	return filepath.Join(root, volumeMountPrefix+volumeID, "sandboxes", sandboxID, "workspace")
}

func mustWriteTestFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("preserve exact identity"), 0o600); err != nil {
		t.Fatal(err)
	}
}
