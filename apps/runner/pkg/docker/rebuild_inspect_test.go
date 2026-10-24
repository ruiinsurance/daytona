// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package docker

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/daytonaio/runner/pkg/api/dto"
)

func TestRebuildInspectNeverStartsStoppedContainer(t *testing.T) {
	var starts atomic.Int32
	api := newStoppedContainerClient(t, "same-id", &starts)
	d := newStartTestDockerClient(api)
	subpath := "sandboxes/same-id/workspace"
	volumes := []dto.VolumeDTO{
		{VolumeId: "44444444-4444-4444-8444-444444444444", MountPath: "/workspace", Subpath: &subpath, Backend: localVolumeBackend},
		{VolumeId: "44444444-4444-4444-8444-444444444444", MountPath: "/config", Subpath: &subpath, Backend: localVolumeBackend},
	}
	_, _, _, err := d.InspectRebuildWorkspace(context.Background(), "same-id", volumes)
	if err == nil || starts.Load() != 0 {
		t.Fatalf("inspection must reject stopped compute without starting: %v, starts=%d", err, starts.Load())
	}
}

func TestRebuildInspectInvalidExpectationHasNoDockerSideEffects(t *testing.T) {
	// Nil Docker client intentionally panics if any Docker call is attempted.
	d := &DockerClient{}
	if _, _, _, err := d.InspectRebuildWorkspace(context.Background(), "same-id", nil); err == nil {
		t.Fatal("missing canonical mounts must fail before Docker access")
	}
}
