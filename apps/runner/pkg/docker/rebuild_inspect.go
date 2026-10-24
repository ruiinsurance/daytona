// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package docker

import (
	"context"
	"fmt"

	"github.com/daytonaio/runner/pkg/api/dto"
)

// InspectRebuildWorkspace never mounts, starts, stops, creates or repairs anything.
// Reuse the existing bind/device verifier without its failClosed kill path.
func (d *DockerClient) InspectRebuildWorkspace(ctx context.Context, sandboxID string, volumes []dto.VolumeDTO) (string, string, string, error) {
	if len(volumes) != 2 {
		return "", "", "", fmt.Errorf("rebuild requires the exact local workspace/config pair")
	}
	for _, volume := range volumes {
		if volume.Backend != localVolumeBackend || volume.Subpath == nil || *volume.Subpath != "sandboxes/"+sandboxID+"/workspace" {
			return "", "", "", fmt.Errorf("rebuild workspace identity mismatch")
		}
	}
	if err := validateLocalVolumePair(volumes); err != nil {
		return "", "", "", err
	}
	inspected, err := d.ContainerInspect(ctx, sandboxID)
	if err != nil {
		return "", "", "", err
	}
	if inspected == nil || inspected.ContainerJSONBase == nil || inspected.State == nil || !inspected.State.Running || inspected.Config == nil || inspected.Config.Image == "" {
		return "", "", "", fmt.Errorf("rebuild requires an existing running container with image identity")
	}
	if err := d.verifyLocalContainerInspectMounts(inspected, volumes); err != nil {
		return "", "", "", err
	}
	if err := d.verifyContainerVolumeMountDevices(ctx, inspected, volumes); err != nil {
		return "", "", "", err
	}
	return inspected.ID, inspected.Created, inspected.Config.Image, nil
}
