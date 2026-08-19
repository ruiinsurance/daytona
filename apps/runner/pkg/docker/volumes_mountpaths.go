// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package docker

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/daytonaio/common-go/pkg/log"
	"github.com/daytonaio/runner/cmd/runner/config"
	"github.com/daytonaio/runner/pkg/api/dto"
	"github.com/google/uuid"
)

const volumeMountPrefix = "daytona-volume-"
const (
	perVolumeBucketLayout    = "per-volume-bucket"
	singleBucketPrefixLayout = "single-bucket-prefix"
	volumeMountReadyTimeout  = 5 * time.Second
)

// volumeId becomes part of the host mount path and the S3 bucket name, so require
// the canonical lowercase UUID form (rejects braced/URN/dashless/uppercase variants,
// which uuid.Parse would otherwise accept).
func isValidVolumeId(volumeId string) bool {
	parsed, err := uuid.Parse(volumeId)
	if err != nil {
		return false
	}
	return parsed.String() == volumeId
}

func getVolumeMountBasePath() string {
	if config.GetEnvironment() == "development" {
		return "/tmp"
	}
	return "/mnt"
}

func resolveVolumeMountPaths(vol dto.VolumeDTO) (baseMountPath string, bindSource string, err error) {
	if !isValidVolumeId(vol.VolumeId) {
		return "", "", fmt.Errorf("invalid volumeId %q: must be a volume UUID", vol.VolumeId)
	}

	volumeIdPrefixed := fmt.Sprintf("%s%s", volumeMountPrefix, vol.VolumeId)
	mountBase := filepath.Clean(getVolumeMountBasePath())
	baseMountPath = filepath.Join(mountBase, volumeIdPrefixed)
	if filepath.Dir(baseMountPath) != mountBase || filepath.Base(baseMountPath) != volumeIdPrefixed {
		return "", "", fmt.Errorf("invalid volumeId %q: resolves outside volume mount base", vol.VolumeId)
	}

	bindSource = baseMountPath
	if vol.Subpath == nil || *vol.Subpath == "" {
		return baseMountPath, bindSource, nil
	}
	if filepath.IsAbs(*vol.Subpath) {
		return "", "", fmt.Errorf("invalid subpath %q: expected a relative path", *vol.Subpath)
	}

	bindSource = filepath.Join(baseMountPath, *vol.Subpath)
	relativePath, err := filepath.Rel(baseMountPath, bindSource)
	if err != nil || relativePath == ".." || strings.HasPrefix(relativePath, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("invalid subpath %q: resolves outside volume mount", *vol.Subpath)
	}

	return baseMountPath, bindSource, nil
}

func (d *DockerClient) getVolumesMountPathBinds(ctx context.Context, volumes []dto.VolumeDTO, sandboxID string) ([]string, error) {
	hasLocalFirst := false
	for _, volume := range volumes {
		switch volume.Backend {
		case "":
		case localFirstBackend:
			hasLocalFirst = true
		case "legacy-cos":
		default:
			return nil, fmt.Errorf("unsupported volume backend %q", volume.Backend)
		}
	}
	if hasLocalFirst && (!d.localFirstStorageEnabled || !isCanonicalUUID(d.storageNodeId)) {
		return nil, fmt.Errorf("local-first storage is not enabled or Runner node identity is missing")
	}
	if hasLocalFirst {
		for _, volume := range volumes {
			if (volume.MountPath == localWorkspaceMountPath || volume.MountPath == localConfigMountPath) && volume.Backend != localFirstBackend {
				return nil, fmt.Errorf("local-first mount target %q conflicts with a non-local-first volume", volume.MountPath)
			}
		}
	}
	localSources, err := resolveLocalFirstMountSources(volumes, d.localStorageRoot, d.storageNodeId, sandboxID, time.Now())
	if err != nil {
		return nil, err
	}

	// Phase 1: fan out FUSE mounts for unique volumes in parallel. Each
	// ensureVolumeFuseMounted runs mount-s3 and then waits up to 5s for the
	// mount to become ready; doing them sequentially made create-time scale
	// linearly with the number of mounted volumes.
	uniqueMounts := make(map[string]string, len(volumes)) // volumeIdPrefixed -> baseMountPath
	for index, vol := range volumes {
		if _, local := localSources[index]; local {
			continue
		}
		baseMountPath, _, err := resolveVolumeMountPaths(vol)
		if err != nil {
			return nil, err
		}
		volumeIdPrefixed := filepath.Base(baseMountPath)
		if _, ok := uniqueMounts[volumeIdPrefixed]; !ok {
			uniqueMounts[volumeIdPrefixed] = baseMountPath
		}
	}

	mountCtx, cancelMounts := context.WithCancel(ctx)
	defer cancelMounts()

	var (
		wg       sync.WaitGroup
		errMu    sync.Mutex
		firstErr error
	)
	for volumeIdPrefixed, baseMountPath := range uniqueMounts {
		wg.Add(1)
		go func(volumeId, mountPath string) {
			defer wg.Done()
			if err := d.ensureVolumeFuseMounted(mountCtx, volumeId, mountPath); err != nil {
				errMu.Lock()
				if firstErr == nil {
					firstErr = err
					cancelMounts()
				}
				errMu.Unlock()
			}
		}(strings.TrimPrefix(volumeIdPrefixed, volumeMountPrefix), baseMountPath)
	}
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}

	// Phase 2: build bind strings in input order. Subpath mkdir is cheap and
	// kept sequential so the returned slice order matches volumes.
	volumeMountPathBinds := make([]string, 0, len(volumes))
	for index, vol := range volumes {
		bindSource, local := localSources[index]
		if !local {
			_, bindSource, err = resolveVolumeMountPaths(vol)
			if err != nil {
				return nil, err
			}
		}
		subpathStr := ""
		if vol.Subpath != nil {
			subpathStr = *vol.Subpath
		}

		if !local && vol.Subpath != nil && *vol.Subpath != "" {
			err := os.MkdirAll(bindSource, 0755)
			if err != nil {
				return nil, fmt.Errorf("failed to create subpath directory %s: %s", bindSource, err)
			}
		}

		d.logger.DebugContext(ctx, "binding volume subpath", "volumeId", volumeMountPrefix+vol.VolumeId, "subpath", subpathStr, "mountPath", vol.MountPath)
		volumeMountPathBinds = append(volumeMountPathBinds, fmt.Sprintf("%s/:%s/", bindSource, vol.MountPath))
	}

	return volumeMountPathBinds, nil
}

func (d *DockerClient) ensureVolumeFuseMounted(ctx context.Context, volumeId string, mountPath string) error {
	d.volumeMutexesMutex.Lock()
	volumeMutex, exists := d.volumeMutexes[volumeId]
	if !exists {
		volumeMutex = &sync.Mutex{}
		d.volumeMutexes[volumeId] = volumeMutex
	}
	d.volumeMutexesMutex.Unlock()

	volumeMutex.Lock()
	defer volumeMutex.Unlock()

	if d.isDirectoryMounted(mountPath) {
		if err := d.waitForMountReady(ctx, mountPath); err != nil {
			return fmt.Errorf("existing S3 volume mount %s is not ready: %w", mountPath, err)
		}
		d.logger.DebugContext(ctx, "volume already mounted", "volumeId", volumeId, "mountPath", mountPath)
		return nil
	}

	// Track if directory existed before we create it
	_, statErr := os.Stat(mountPath)
	dirExisted := statErr == nil

	err := os.MkdirAll(mountPath, 0755)
	if err != nil {
		return fmt.Errorf("failed to create mount directory %s: %s", mountPath, err)
	}

	d.logger.InfoContext(ctx, "mounting S3 volume", "volumeId", volumeId, "mountPath", mountPath)

	cmd, err := d.getMountCmd(ctx, volumeId, mountPath)
	if err != nil {
		if !dirExisted {
			removeErr := os.Remove(mountPath)
			if removeErr != nil {
				d.logger.WarnContext(ctx, "failed to remove mount directory", "path", mountPath, "error", removeErr)
			}
		}
		return err
	}
	err = cmd.Run()
	if err != nil {
		if !dirExisted {
			removeErr := os.Remove(mountPath)
			if removeErr != nil {
				d.logger.WarnContext(ctx, "failed to remove mount directory", "path", mountPath, "error", removeErr)
			}
		}
		return fmt.Errorf("failed to mount S3 volume %s to %s: %s", volumeId, mountPath, err)
	}

	err = d.waitForMountReady(ctx, mountPath)
	if err != nil {
		if !dirExisted {
			umountErr := exec.Command("umount", mountPath).Run()
			if umountErr != nil {
				d.logger.WarnContext(ctx, "failed to unmount during cleanup", "path", mountPath, "error", umountErr)
			}
			removeErr := os.Remove(mountPath)
			if removeErr != nil {
				d.logger.WarnContext(ctx, "failed to remove mount directory during cleanup", "path", mountPath, "error", removeErr)
			}
		}
		return fmt.Errorf("mount %s not ready after mounting: %s", mountPath, err)
	}

	d.logger.InfoContext(ctx, "mounted S3 volume", "volumeId", volumeId, "mountPath", mountPath)
	return nil
}

func (d *DockerClient) isDirectoryMounted(path string) bool {
	cmd := exec.Command("mountpoint", path)
	_, err := cmd.Output()

	return err == nil
}

func probeMountDirectory(ctx context.Context, path string) error {
	result := make(chan error, 1)
	go func() {
		info, err := os.Stat(path)
		if err != nil {
			result <- err
			return
		}
		if !info.IsDir() {
			result <- fmt.Errorf("mount path is not a directory")
			return
		}

		dir, err := os.Open(path)
		if err != nil {
			result <- err
			return
		}
		defer dir.Close()

		_, err = dir.Readdirnames(1)
		if err == io.EOF {
			err = nil
		}
		result <- err
	}()

	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// waitForMountReady waits for a FUSE mount to be fully accessible
// FUSE mounts can be asynchronous - the mount command may return before the filesystem is ready
// This prevents a race condition where the container writes to the directory before the mount is ready
func (d *DockerClient) waitForMountReady(ctx context.Context, path string) error {
	readyCtx, cancel := context.WithTimeout(ctx, volumeMountReadyTimeout)
	defer cancel()

	maxAttempts := 50 // 5 seconds total (50 * 100ms)
	sleepDuration := 100 * time.Millisecond
	var lastErr error

	for i := 0; i < maxAttempts; i++ {
		// First verify the mountpoint is still registered
		if !d.isDirectoryMounted(path) {
			return fmt.Errorf("mount disappeared during readiness check")
		}

		if err := probeMountDirectory(readyCtx, path); err == nil {
			d.logger.InfoContext(ctx, "mount is ready", "path", path, "attempts", i+1)
			return nil
		} else {
			lastErr = err
		}

		// Wait a bit before retrying
		select {
		case <-readyCtx.Done():
			return fmt.Errorf("mount readiness probe failed: %w", lastErr)
		case <-time.After(sleepDuration):
			// Continue to next iteration
		}
	}

	return fmt.Errorf("mount did not become ready within timeout: %w", lastErr)
}

func (d *DockerClient) getMountArgs(volumeId string, path string) ([]string, error) {
	if !isValidVolumeId(volumeId) {
		return nil, fmt.Errorf("invalid volumeId %q: must be a canonical lowercase UUID", volumeId)
	}

	args := []string{"--allow-other", "--allow-delete", "--allow-overwrite", "--file-mode", "0666", "--dir-mode", "0777"}
	switch d.awsVolumeLayout {
	case "", perVolumeBucketLayout:
		args = append(args, volumeMountPrefix+volumeId, path)
	case singleBucketPrefixLayout:
		if err := validateFixedBucket(d.awsDefaultBucket); err != nil {
			return nil, err
		}
		prefix, err := buildCanonicalVolumePrefix(d.awsVolumePrefix, volumeId)
		if err != nil {
			return nil, err
		}
		args = append(args, "--prefix", prefix, d.awsDefaultBucket, path)
	default:
		return nil, fmt.Errorf("unsupported AWS volume layout %q", d.awsVolumeLayout)
	}
	return args, nil
}

func validateFixedBucket(bucket string) error {
	if bucket == "" || bucket != strings.TrimSpace(bucket) || strings.ContainsAny(bucket, `/\`) {
		return fmt.Errorf("invalid fixed S3 bucket %q: expected a non-empty bucket name", bucket)
	}
	return nil
}

func buildCanonicalVolumePrefix(rootPrefix string, volumeId string) (string, error) {
	if rootPrefix == "" || rootPrefix != strings.TrimSpace(rootPrefix) || strings.HasSuffix(rootPrefix, "/") || strings.Contains(rootPrefix, `\`) {
		return "", fmt.Errorf("invalid volume prefix %q: expected a non-empty canonical relative path without a trailing slash", rootPrefix)
	}
	for _, segment := range strings.Split(rootPrefix, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", fmt.Errorf("invalid volume prefix %q: expected a non-empty canonical relative path", rootPrefix)
		}
	}

	prefix := rootPrefix + "/" + volumeId + "/"
	if strings.HasPrefix(prefix, "/") {
		return "", fmt.Errorf("invalid volume prefix %q: expected a relative path", rootPrefix)
	}
	return prefix, nil
}

func (d *DockerClient) getMountCmd(ctx context.Context, volumeId string, path string) (*exec.Cmd, error) {
	args, err := d.getMountArgs(volumeId, path)
	if err != nil {
		return nil, err
	}

	var envVars []string
	if d.awsEndpointUrl != "" {
		envVars = append(envVars, "AWS_ENDPOINT_URL="+d.awsEndpointUrl)
	}
	if d.awsAccessKeyId != "" {
		envVars = append(envVars, "AWS_ACCESS_KEY_ID="+d.awsAccessKeyId)
	}
	if d.awsSecretAccessKey != "" {
		envVars = append(envVars, "AWS_SECRET_ACCESS_KEY="+d.awsSecretAccessKey)
	}
	if d.awsRegion != "" {
		envVars = append(envVars, "AWS_REGION="+d.awsRegion)
	}

	// No systemd (containerized) — daemon orphan survives runner restarts naturally.
	// CommandContext is used so ctx cancellation can stop a slow mount-s3 startup;
	// once mount-s3 daemonizes (no --foreground), cmd.Run returns and ctx no longer has a leash.
	cmd := exec.CommandContext(ctx, "mount-s3", args...)
	cmd.Env = envVars

	_, err = os.Stat("/run/systemd/system")
	if err == nil {
		// Isolate mount-s3 in its own cgroup so the FUSE daemon survives runner restarts.
		sdArgs := []string{"--scope"}
		for _, env := range envVars {
			sdArgs = append(sdArgs, "--setenv="+env)
		}
		sdArgs = append(sdArgs, "--", "mount-s3")
		sdArgs = append(sdArgs, args...)
		cmd = exec.CommandContext(ctx, "systemd-run", sdArgs...)
	}

	cmd.Stderr = io.Writer(&log.ErrorLogWriter{})
	cmd.Stdout = io.Writer(&log.InfoLogWriter{})

	return cmd, nil
}
