// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package docker

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/daytonaio/runner/pkg/api/dto"
	"github.com/docker/docker/api/types/container"
)

func currentProcessInspectResponse() *container.InspectResponse {
	return &container.InspectResponse{
		ContainerJSONBase: &container.ContainerJSONBase{
			ID: "device-verification-test",
			State: &container.State{
				Running: true,
				Pid:     os.Getpid(),
			},
		},
	}
}

func prepareVolumeVerificationSource(t *testing.T) (dto.VolumeDTO, string) {
	t.Helper()
	requireTestRunnerConfig(t)
	prepareResponsiveVolumeMount(t)

	subpath := "device-verification"
	baseMountPath := filepath.Join(os.TempDir(), volumeMountPrefix+testVolumeID)
	bindSource := filepath.Join(baseMountPath, subpath)
	if err := os.MkdirAll(bindSource, 0o755); err != nil {
		t.Fatalf("create bind source: %v", err)
	}
	return dto.VolumeDTO{VolumeId: testVolumeID, Subpath: &subpath}, bindSource
}

func TestVerifyContainerVolumeMountDevicesAcceptsMatchingDevice(t *testing.T) {
	volume, bindSource := prepareVolumeVerificationSource(t)
	volume.MountPath = bindSource

	dockerClient := newStartTestDockerClient(nil)
	if err := dockerClient.verifyContainerVolumeMountDevices(context.Background(), currentProcessInspectResponse(), []dto.VolumeDTO{volume}); err != nil {
		t.Fatalf("verifyContainerVolumeMountDevices() error = %v, want matching devices to pass", err)
	}
}

func TestVerifyContainerVolumeMountDevicesRejectsDifferentDevice(t *testing.T) {
	volume, bindSource := prepareVolumeVerificationSource(t)
	otherDevicePath, err := os.MkdirTemp("/dev/shm", "daytona-volume-device-test-")
	if err != nil {
		t.Skipf("create directory on a second filesystem: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(otherDevicePath) })

	bindDevice, err := filesystemDevice(bindSource)
	if err != nil {
		t.Fatalf("inspect bind source device: %v", err)
	}
	otherDevice, err := filesystemDevice(otherDevicePath)
	if err != nil {
		t.Fatalf("inspect alternate device: %v", err)
	}
	if bindDevice == otherDevice {
		t.Skip("test environment does not expose a second filesystem device")
	}
	volume.MountPath = otherDevicePath

	dockerClient := newStartTestDockerClient(nil)
	err = dockerClient.verifyContainerVolumeMountDevices(context.Background(), currentProcessInspectResponse(), []dto.VolumeDTO{volume})
	if err == nil || !strings.Contains(err.Error(), "expected bind source device") {
		t.Fatalf("verifyContainerVolumeMountDevices() error = %v, want a device mismatch error", err)
	}
}

func TestContainerVolumeTargetPathRejectsRelativeMountPath(t *testing.T) {
	if target, err := containerVolumeTargetPath(os.Getpid(), "workspace"); err == nil || target != "" {
		t.Fatalf("containerVolumeTargetPath() = %q, %v; want a relative-path error", target, err)
	}
}

func TestGetSandboxStartMetadataIncludesDeclaredVolumes(t *testing.T) {
	subpath := "sandboxes/test/workspace"
	originalMetadata := map[string]string{"organizationId": "test-organization"}
	sandbox := dto.CreateSandboxDTO{
		Metadata: originalMetadata,
		Volumes: []dto.VolumeDTO{{
			VolumeId:  testVolumeID,
			MountPath: "/workspace",
			Subpath:   &subpath,
		}},
	}

	metadata, err := getSandboxStartMetadata(sandbox)
	if err != nil {
		t.Fatalf("getSandboxStartMetadata() error = %v", err)
	}
	if metadata["organizationId"] != "test-organization" {
		t.Fatalf("getSandboxStartMetadata() dropped caller metadata: %#v", metadata)
	}
	if _, mutated := originalMetadata["volumes"]; mutated {
		t.Fatal("getSandboxStartMetadata() mutated the caller metadata map")
	}
	var volumes []dto.VolumeDTO
	if err := json.Unmarshal([]byte(metadata["volumes"]), &volumes); err != nil {
		t.Fatalf("decode serialized volumes: %v", err)
	}
	if len(volumes) != 1 || volumes[0].VolumeId != testVolumeID || volumes[0].MountPath != "/workspace" {
		t.Fatalf("serialized volumes = %#v, want the declared workspace volume", volumes)
	}
}
