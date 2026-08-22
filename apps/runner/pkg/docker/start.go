// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/daytonaio/common-go/pkg/timer"
	"github.com/daytonaio/runner/pkg/api/dto"
	"github.com/daytonaio/runner/pkg/common"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/strslice"
)

type containerVolumeMountVerifier func(context.Context, *container.InspectResponse, []dto.VolumeDTO) error

func (d *DockerClient) Start(ctx context.Context, containerId string, authToken *string, metadata map[string]string) (*container.InspectResponse, string, error) {
	defer timer.Timer()()

	// Cancel a backup if it's already in progress
	backup_context, ok := backup_context_map.Get(containerId)
	if ok {
		backup_context.cancel()
	}

	c, err := d.ContainerInspect(ctx, containerId)
	if err != nil {
		return nil, "", err
	}

	var volumes []dto.VolumeDTO
	if volumesJSON, ok := metadata["volumes"]; ok {
		if err := json.Unmarshal([]byte(volumesJSON), &volumes); err != nil {
			volumeErr := fmt.Errorf("invalid persisted volume metadata: %w", err)
			return nil, "", d.failClosedContainerVolumeMount(ctx, c, volumeErr)
		}
		if len(volumes) > 0 {
			if _, err = d.getVolumesMountPathBinds(ctx, volumes); err != nil {
				volumeErr := fmt.Errorf("failed to ensure volume FUSE mounts: %w", err)
				return nil, "", d.failClosedContainerVolumeMount(ctx, c, volumeErr)
			}
			if err = d.verifyLocalContainerInspectMounts(c, volumes); err != nil {
				volumeErr := fmt.Errorf("verify local volume binds before start: %w", err)
				return nil, "", d.failClosedContainerVolumeMount(ctx, c, volumeErr)
			}
		}
	}

	if c.State.Running {
		if err := d.verifyContainerVolumeMounts(ctx, c, volumes); err != nil {
			return nil, "", d.failClosedContainerVolumeMount(ctx, c, err)
		}

		containerIP := GetContainerIpAddress(ctx, c)
		if containerIP == "" {
			return nil, "", errors.New("sandbox IP not found? Is the sandbox started?")
		}

		if isAndroidDeviceContainer(c) {
			if err := d.waitForAdbRunning(ctx, containerIP); err != nil {
				return nil, "", err
			}
			return c, "", nil
		}

		daemonVersion, err := d.waitForDaemonRunning(ctx, containerIP, authToken)
		if err != nil {
			return nil, "", err
		}

		return c, daemonVersion, nil
	}

	err = d.apiClient.ContainerStart(ctx, containerId, container.StartOptions{})
	if err != nil {
		return nil, "", err
	}

	// make sure container is running
	runningContainer, err := d.waitForContainerRunning(ctx, containerId)
	if err != nil {
		return nil, "", err
	}
	if err := d.verifyContainerVolumeMounts(ctx, runningContainer, volumes); err != nil {
		return nil, "", d.failClosedContainerVolumeMount(ctx, runningContainer, err)
	}

	containerIP := GetContainerIpAddress(ctx, runningContainer)
	if containerIP == "" {
		return nil, "", errors.New("sandbox IP not found? Is the sandbox started?")
	}

	// Android-device sandboxes do not run the daytona daemon. Readiness is signaled by
	// the ADB port accepting TCP connections inside the container.
	if isAndroidDeviceContainer(runningContainer) {
		if err := d.waitForAdbRunning(ctx, containerIP); err != nil {
			return nil, "", err
		}

		if metadata["limitNetworkEgress"] == "true" {
			go func() {
				containerShortId := c.ID[:12]
				if err := d.netRulesManager.SetNetworkLimiter(containerShortId, containerIP); err != nil {
					d.logger.ErrorContext(ctx, "Failed to set network limiter", "error", err)
				}
			}()
		}

		return runningContainer, "", nil
	}

	if !slices.Equal(c.Config.Entrypoint, strslice.StrSlice{common.DAEMON_PATH}) {
		processesCtx := context.Background()
		go func() {
			if err := d.startDaytonaDaemon(processesCtx, containerId, c.Config.WorkingDir); err != nil {
				d.logger.ErrorContext(ctx, "Failed to start Daytona daemon", "error", err)
			}
		}()
	}

	// If daemon is the sandbox entrypoint (common.DAEMON_PATH), it is started as part of the sandbox;
	// Otherwise, the daemon is started separately above.
	// In either case, we wait for it here.
	daemonVersion, err := d.waitForDaemonRunning(ctx, containerIP, authToken)
	if err != nil {
		return nil, "", err
	}

	if metadata["limitNetworkEgress"] == "true" {
		go func() {
			containerShortId := c.ID[:12]
			err = d.netRulesManager.SetNetworkLimiter(containerShortId, containerIP)
			if err != nil {
				d.logger.ErrorContext(ctx, "Failed to set network limiter", "error", err)
			}
		}()
	}

	return runningContainer, daemonVersion, nil
}

func (d *DockerClient) waitForContainerRunning(ctx context.Context, containerId string) (*container.InspectResponse, error) {
	defer timer.Timer()()

	timeout := time.Duration(d.sandboxStartTimeoutSec) * time.Second
	timeoutCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-timeoutCtx.Done():
			return nil, errors.New("timeout waiting for the sandbox to start - please ensure that your entrypoint is long-running")
		case <-ticker.C:
			c, err := d.ContainerInspect(timeoutCtx, containerId)
			if err != nil {
				return nil, err
			}

			if c.State.Running {
				return c, nil
			}
		}
	}
}
