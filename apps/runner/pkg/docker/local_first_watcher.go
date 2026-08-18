// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package docker

import (
	"context"
	"errors"
	"time"

	"github.com/daytonaio/runner/pkg/api/dto"
	"github.com/daytonaio/runner/pkg/localfirst"
)

func (d *DockerClient) startLocalFirstWorkspaceWatcher(
	ctx context.Context,
	sandboxID string,
	volumes []dto.VolumeDTO,
) error {
	if d.workspaceWatcher == nil {
		return nil
	}

	sources, err := resolveLocalFirstMountSources(volumes, d.localStorageRoot, d.storageNodeId, sandboxID, time.Now())
	if err != nil {
		return errors.New("workspace_watcher_start_failed")
	}
	for index, volume := range volumes {
		if volume.Backend != localFirstBackend || volume.MountPath != localWorkspaceMountPath {
			continue
		}
		workspacePath, ok := sources[index]
		if !ok {
			return errors.New("workspace_watcher_start_failed")
		}
		if err := d.workspaceWatcher.Start(ctx, localfirst.WorkspaceWatchSpec{
			WorkspacePath: workspacePath,
			StorageRoot:   d.localStorageRoot,
			NodeID:        d.storageNodeId,
			VolumeID:      volume.VolumeId,
			SandboxID:     sandboxID,
		}); err != nil {
			return errors.New("workspace_watcher_start_failed")
		}
		return nil
	}
	return nil
}

func (d *DockerClient) stopLocalFirstWorkspaceWatcher(sandboxID string) {
	if d.workspaceWatcher != nil {
		d.workspaceWatcher.Stop(sandboxID)
	}
}

func (d *DockerClient) CloseLocalFirstWorkspaceWatcher() error {
	if d.workspaceWatcher == nil {
		return nil
	}
	return d.workspaceWatcher.Close()
}
