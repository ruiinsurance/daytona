// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package docker

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/daytonaio/runner/pkg/api/dto"
)

const (
	localTestNodeID    = "11111111-1111-4111-8111-111111111111"
	localTestVolumeID  = "22222222-2222-4222-8222-222222222222"
	localTestSandboxID = "33333333-3333-4333-8333-333333333333"
)

func localTestVolumes(expiresAt time.Time) []dto.VolumeDTO {
	workspaceSubpath := "sandboxes/" + localTestSandboxID + "/workspace"
	return []dto.VolumeDTO{
		{
			VolumeId:       localTestVolumeID,
			MountPath:      localWorkspaceMountPath,
			Subpath:        &workspaceSubpath,
			Backend:        localFirstBackend,
			NodeId:         localTestNodeID,
			FenceEpoch:     "7",
			LeaseOwner:     "runner:process",
			LeaseExpiresAt: expiresAt.UTC().Format(time.RFC3339Nano),
		},
		{
			VolumeId:       localTestVolumeID,
			MountPath:      localConfigMountPath,
			Subpath:        &workspaceSubpath,
			Backend:        localFirstBackend,
			NodeId:         localTestNodeID,
			FenceEpoch:     "7",
			LeaseOwner:     "runner:process",
			LeaseExpiresAt: expiresAt.UTC().Format(time.RFC3339Nano),
		},
	}
}

func TestLocalFirstMountsUseOneCanonicalSourceForWorkspaceAndConfig(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	client := &DockerClient{
		logger:                   slog.New(slog.NewTextHandler(io.Discard, nil)),
		localFirstStorageEnabled: true,
		localStorageRoot:         root,
		storageNodeId:            localTestNodeID,
	}

	binds, err := client.getVolumesMountPathBinds(context.Background(), localTestVolumes(now.Add(time.Minute)), localTestSandboxID)
	if err != nil {
		t.Fatalf("getVolumesMountPathBinds() error = %v", err)
	}

	wantSource := filepath.Join(root, "nodes", localTestNodeID, "volumes", localTestVolumeID, "sandboxes", localTestSandboxID, "workspace")
	want := []string{wantSource + "/:/workspace/", wantSource + "/:/config/"}
	if strings.Join(binds, "\n") != strings.Join(want, "\n") {
		t.Fatalf("binds = %#v, want %#v", binds, want)
	}

	workspaceInfo, err := os.Stat(wantSource)
	if err != nil {
		t.Fatalf("stat local-first source: %v", err)
	}
	configInfo, err := os.Stat(wantSource)
	if err != nil {
		t.Fatalf("stat local-first config source: %v", err)
	}
	if !os.SameFile(workspaceInfo, configInfo) {
		t.Fatal("workspace and config sources are not the same inode")
	}
}

func TestLocalFirstMountsRejectMissingConfigAliasAndStaleLease(t *testing.T) {
	root := t.TempDir()
	volumes := localTestVolumes(time.Now().Add(time.Minute))
	client := &DockerClient{
		logger:                   slog.New(slog.NewTextHandler(io.Discard, nil)),
		localFirstStorageEnabled: true,
		localStorageRoot:         root,
		storageNodeId:            localTestNodeID,
	}

	_, err := client.getVolumesMountPathBinds(context.Background(), volumes[:1], localTestSandboxID)
	if err == nil || !strings.Contains(err.Error(), "requires explicit /workspace and /config") {
		t.Fatalf("missing config alias error = %v", err)
	}

	stale := localTestVolumes(time.Now().Add(-time.Minute))
	_, err = client.getVolumesMountPathBinds(context.Background(), stale, localTestSandboxID)
	if err == nil || !strings.Contains(err.Error(), "lease is expired") {
		t.Fatalf("stale lease error = %v", err)
	}
}

func TestLocalFirstMountsRejectSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	volumeDir := filepath.Join(root, "nodes", localTestNodeID, "volumes", localTestVolumeID)
	if err := os.MkdirAll(filepath.Dir(volumeDir), 0o770); err != nil {
		t.Fatalf("create volume parent: %v", err)
	}
	if err := os.Symlink(outside, volumeDir); err != nil {
		t.Fatalf("create volume symlink: %v", err)
	}

	workspaceSubpath := "sandboxes/" + localTestSandboxID + "/workspace"
	_, err := resolveLocalFirstVolumeSource(dto.VolumeDTO{
		VolumeId:       localTestVolumeID,
		MountPath:      localWorkspaceMountPath,
		Subpath:        &workspaceSubpath,
		Backend:        localFirstBackend,
		NodeId:         localTestNodeID,
		FenceEpoch:     "1",
		LeaseOwner:     "runner:process",
		LeaseExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano),
	}, root, localTestNodeID, localTestSandboxID, time.Now())
	if err == nil || !strings.Contains(err.Error(), "escapes storage root") {
		t.Fatalf("symlink escape error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "sandboxes")); !os.IsNotExist(err) {
		t.Fatalf("resolver touched the symlink target before rejecting it: %v", err)
	}
}
