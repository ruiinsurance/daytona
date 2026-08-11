// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package docker

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/daytonaio/runner/pkg/api/dto"
	"github.com/docker/docker/api/types/container"
)

const unsafeVolumeStopTimeout = 15 * time.Second
const maxContainerTargetSymlinks = 40

func filesystemDevice(path string) (uint64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return filesystemDeviceFromInfo(path, info)
}

func filesystemDeviceFromInfo(path string, info os.FileInfo) (uint64, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, fmt.Errorf("filesystem device is unavailable for %s", path)
	}
	return uint64(stat.Dev), nil
}

func containerVolumeTargetPath(pid int, mountPath string) (string, error) {
	if pid <= 0 {
		return "", fmt.Errorf("container PID must be positive")
	}
	containerRoot := filepath.Join("/proc", strconv.Itoa(pid), "root")
	return volumeTargetPath(containerRoot, mountPath)
}

func volumeTargetPath(containerRoot string, mountPath string) (string, error) {
	cleanContainerRoot := filepath.Clean(containerRoot)
	if !filepath.IsAbs(cleanContainerRoot) {
		return "", fmt.Errorf("container root %q must be absolute", containerRoot)
	}
	cleanMountPath := filepath.Clean(mountPath)
	if !filepath.IsAbs(cleanMountPath) {
		return "", fmt.Errorf("volume mount path %q must be absolute", mountPath)
	}

	targetPath := filepath.Join(cleanContainerRoot, strings.TrimPrefix(cleanMountPath, string(filepath.Separator)))
	relativePath, err := filepath.Rel(cleanContainerRoot, targetPath)
	if err != nil || relativePath == ".." || strings.HasPrefix(relativePath, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("volume mount path %q resolves outside container root", mountPath)
	}
	return targetPath, nil
}

func filesystemDeviceInContainerRoot(containerRoot string, mountPath string) (uint64, error) {
	cleanContainerRoot := filepath.Clean(containerRoot)
	if _, err := volumeTargetPath(cleanContainerRoot, mountPath); err != nil {
		return 0, err
	}

	remaining := splitContainerPath(filepath.Clean(mountPath))
	resolved := make([]string, 0, len(remaining))
	symlinkCount := 0

	for len(remaining) > 0 {
		component := remaining[0]
		remaining = remaining[1:]
		switch component {
		case "", ".":
			continue
		case "..":
			if len(resolved) > 0 {
				resolved = resolved[:len(resolved)-1]
			}
			continue
		}

		candidateParts := append(append([]string{}, resolved...), component)
		candidatePath := filepath.Join(append([]string{cleanContainerRoot}, candidateParts...)...)
		info, err := os.Lstat(candidatePath)
		if err != nil {
			return 0, err
		}
		if info.Mode()&os.ModeSymlink == 0 {
			resolved = append(resolved, component)
			continue
		}

		symlinkCount++
		if symlinkCount > maxContainerTargetSymlinks {
			return 0, fmt.Errorf("container volume target %q exceeds %d symbolic links", mountPath, maxContainerTargetSymlinks)
		}
		linkTarget, err := os.Readlink(candidatePath)
		if err != nil {
			return 0, err
		}
		if filepath.IsAbs(linkTarget) {
			resolved = resolved[:0]
		}
		remaining = append(splitContainerPath(linkTarget), remaining...)
	}

	targetPath := filepath.Join(append([]string{cleanContainerRoot}, resolved...)...)
	if len(resolved) == 0 {
		return filesystemDevice(targetPath)
	}
	info, err := os.Lstat(targetPath)
	if err != nil {
		return 0, err
	}
	return filesystemDeviceFromInfo(targetPath, info)
}

func splitContainerPath(path string) []string {
	return strings.Split(path, string(filepath.Separator))
}

func (d *DockerClient) verifyContainerVolumeMountDevices(_ context.Context, inspected *container.InspectResponse, volumes []dto.VolumeDTO) error {
	if inspected == nil || inspected.ContainerJSONBase == nil || inspected.State == nil {
		return fmt.Errorf("container inspect response has no state")
	}
	if !inspected.State.Running || inspected.State.Pid <= 0 {
		return fmt.Errorf("container %s is not running with a valid PID", inspected.ID)
	}

	for _, vol := range volumes {
		baseMountPath, bindSource, err := resolveVolumeMountPaths(vol)
		if err != nil {
			return err
		}
		baseDeviceBefore, err := filesystemDevice(baseMountPath)
		if err != nil {
			return fmt.Errorf("inspect volume root %s: %w", baseMountPath, err)
		}
		bindSourceDevice, err := filesystemDevice(bindSource)
		if err != nil {
			return fmt.Errorf("inspect volume bind source %s: %w", bindSource, err)
		}
		containerRoot := filepath.Join("/proc", strconv.Itoa(inspected.State.Pid), "root")
		containerTargetDevice, err := filesystemDeviceInContainerRoot(containerRoot, vol.MountPath)
		if err != nil {
			return fmt.Errorf("inspect container volume target %s: %w", vol.MountPath, err)
		}
		baseDeviceAfter, err := filesystemDevice(baseMountPath)
		if err != nil {
			return fmt.Errorf("reinspect volume root %s: %w", baseMountPath, err)
		}

		if baseDeviceBefore != baseDeviceAfter {
			return fmt.Errorf("volume root %s changed devices during verification (%d -> %d)", baseMountPath, baseDeviceBefore, baseDeviceAfter)
		}
		if bindSourceDevice != baseDeviceBefore {
			return fmt.Errorf("volume bind source %s uses device %d, expected mounted volume device %d", bindSource, bindSourceDevice, baseDeviceBefore)
		}
		if containerTargetDevice != bindSourceDevice {
			return fmt.Errorf("container volume target %s uses device %d, expected bind source device %d", vol.MountPath, containerTargetDevice, bindSourceDevice)
		}
	}

	return nil
}

func (d *DockerClient) verifyContainerVolumeMounts(ctx context.Context, inspected *container.InspectResponse, volumes []dto.VolumeDTO) error {
	if len(volumes) == 0 {
		return nil
	}
	if d.containerVolumeMountVerifier != nil {
		return d.containerVolumeMountVerifier(ctx, inspected, volumes)
	}
	return d.verifyContainerVolumeMountDevices(ctx, inspected, volumes)
}

func (d *DockerClient) waitForContainerStopped(ctx context.Context, containerId string) error {
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()

	for {
		inspected, err := d.ContainerInspect(ctx, containerId)
		if err != nil {
			return err
		}
		if inspected == nil || inspected.ContainerJSONBase == nil || inspected.State == nil {
			return fmt.Errorf("container inspect response has no state")
		}
		if !inspected.State.Running {
			return nil
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (d *DockerClient) failClosedContainerVolumeMount(ctx context.Context, inspected *container.InspectResponse, verificationErr error) error {
	if inspected == nil || inspected.ContainerJSONBase == nil || inspected.State == nil || !inspected.State.Running {
		return verificationErr
	}

	d.logger.ErrorContext(ctx, "Container volume mount verification failed; force-stopping sandbox", "containerId", inspected.ID, "forced", true, "error", verificationErr)
	stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), unsafeVolumeStopTimeout)
	defer cancel()

	killErr := d.apiClient.ContainerKill(stopCtx, inspected.ID, "KILL")
	stoppedErr := d.waitForContainerStopped(stopCtx, inspected.ID)
	if stoppedErr != nil {
		return fmt.Errorf("container volume mount verification failed: %w; failed to confirm forced stop: %v", verificationErr, stoppedErr)
	}
	if killErr != nil {
		d.logger.WarnContext(ctx, "Sandbox stopped despite ContainerKill returning an error", "containerId", inspected.ID, "error", killErr)
	}

	return fmt.Errorf("container volume mount verification failed: %w; sandbox was force-stopped", verificationErr)
}
