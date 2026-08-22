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
	localVolumeBackend       = "local"
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

func isCanonicalV4UUID(value string) bool {
	parsed, err := uuid.Parse(value)
	if err != nil {
		return false
	}
	return parsed.String() == value && parsed.Version() == 4
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

func validateLocalWorkspaceSubpath(subpath *string) error {
	if subpath == nil || *subpath == "" || filepath.IsAbs(*subpath) {
		return fmt.Errorf("local volume requires a canonical workspace subpath")
	}
	clean := filepath.Clean(*subpath)
	if clean != *subpath || filepath.Separator != '/' && strings.Contains(*subpath, "/") {
		return fmt.Errorf("local volume requires a canonical workspace subpath")
	}
	parts := strings.Split(filepath.ToSlash(clean), "/")
	if len(parts) != 3 || parts[0] != "sandboxes" || !isCanonicalV4UUID(parts[1]) || parts[2] != "workspace" {
		return fmt.Errorf("local volume requires subpath sandboxes/<canonical-sandbox-uuid>/workspace")
	}
	return nil
}

func validateLocalVolumePair(volumes []dto.VolumeDTO) error {
	localVolumes := make([]dto.VolumeDTO, 0, 2)
	for _, volume := range volumes {
		if volume.Backend == localVolumeBackend {
			localVolumes = append(localVolumes, volume)
		}
	}
	if len(localVolumes) == 0 {
		return fmt.Errorf("runner only supports local volumes")
	}
	if len(localVolumes) != len(volumes) {
		return fmt.Errorf("local volume backend cannot be mixed with COS volumes")
	}
	if len(localVolumes) != 2 {
		return fmt.Errorf("local volume backend requires explicit /workspace and /config binds")
	}

	byTarget := make(map[string]dto.VolumeDTO, 2)
	for _, volume := range localVolumes {
		if volume.MountPath != "/workspace" && volume.MountPath != "/config" {
			return fmt.Errorf("local volume backend only supports /workspace and /config targets")
		}
		if _, exists := byTarget[volume.MountPath]; exists {
			return fmt.Errorf("local volume backend has duplicate %s target", volume.MountPath)
		}
		if err := validateLocalWorkspaceSubpath(volume.Subpath); err != nil {
			return err
		}
		byTarget[volume.MountPath] = volume
	}

	workspace, hasWorkspace := byTarget["/workspace"]
	configVolume, hasConfig := byTarget["/config"]
	if !hasWorkspace || !hasConfig || workspace.Subpath == nil || configVolume.Subpath == nil ||
		workspace.VolumeId != configVolume.VolumeId || *workspace.Subpath != *configVolume.Subpath {
		return fmt.Errorf("/workspace and /config must use the same local source")
	}
	return nil
}

func validateLocalVolumeRoot(configuredRoot string) (string, error) {
	rootPath := filepath.Clean(configuredRoot)
	if configuredRoot == "" || !filepath.IsAbs(rootPath) || rootPath != configuredRoot {
		return "", fmt.Errorf("local volume root must be an absolute canonical path")
	}

	currentPath := string(filepath.Separator)
	for _, component := range strings.Split(strings.TrimPrefix(rootPath, string(filepath.Separator)), string(filepath.Separator)) {
		if component == "" {
			continue
		}
		currentPath = filepath.Join(currentPath, component)
		info, err := os.Lstat(currentPath)
		if os.IsNotExist(err) {
			return "", fmt.Errorf("local volume root does not exist: %s", rootPath)
		}
		if err != nil {
			return "", fmt.Errorf("inspect local volume root component: %w", err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("local volume root must not contain a symbolic link")
		}
		if !info.IsDir() {
			return "", fmt.Errorf("local volume root component is not a directory")
		}
	}

	resolvedRoot, err := filepath.EvalSymlinks(rootPath)
	if err != nil || resolvedRoot != rootPath {
		return "", fmt.Errorf("local volume root must not contain a symbolic link")
	}
	return rootPath, nil
}

func (d *DockerClient) resolveVolumeMountPaths(vol dto.VolumeDTO) (baseMountPath string, bindSource string, err error) {
	switch vol.Backend {
	case localVolumeBackend:
		return d.prepareLocalVolumeMountPaths(vol)
	default:
		return "", "", fmt.Errorf("runner only supports local volumes, got backend %q", vol.Backend)
	}
}

func (d *DockerClient) prepareLocalVolumeMountPaths(vol dto.VolumeDTO) (string, string, error) {
	if !isValidVolumeId(vol.VolumeId) {
		return "", "", fmt.Errorf("invalid volumeId %q: must be a volume UUID", vol.VolumeId)
	}
	if err := validateLocalWorkspaceSubpath(vol.Subpath); err != nil {
		return "", "", err
	}

	rootPath, err := validateLocalVolumeRoot(d.localVolumeRoot)
	if err != nil {
		return "", "", err
	}

	relativeSource := filepath.Join(volumeMountPrefix+vol.VolumeId, *vol.Subpath)
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return "", "", fmt.Errorf("open local volume root: %w", err)
	}
	defer root.Close()
	components := strings.Split(filepath.ToSlash(relativeSource), "/")
	for index := range components {
		componentPath := filepath.Join(components[:index+1]...)
		info, err := root.Lstat(componentPath)
		if os.IsNotExist(err) {
			break
		}
		if err != nil {
			return "", "", fmt.Errorf("inspect local volume source: %w", err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", "", fmt.Errorf("local volume source contains a symbolic link")
		}
		if !info.IsDir() {
			return "", "", fmt.Errorf("local volume source component is not a directory")
		}
	}
	if err := root.MkdirAll(relativeSource, 0o750); err != nil {
		return "", "", fmt.Errorf("create local volume source: %w", err)
	}
	// The sandbox user exists inside the image and cannot be resolved safely on
	// the Runner host. The UUID-scoped directory is mounted only into its owner
	// sandbox, so grant the container user write access at the workspace leaf.
	if err := root.Chmod(relativeSource, 0o777); err != nil {
		return "", "", fmt.Errorf("make local workspace writable: %w", err)
	}

	for index := range components {
		componentPath := filepath.Join(components[:index+1]...)
		info, err := root.Lstat(componentPath)
		if err != nil {
			return "", "", fmt.Errorf("inspect local volume source: %w", err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", "", fmt.Errorf("local volume source contains a symbolic link")
		}
		if !info.IsDir() {
			return "", "", fmt.Errorf("local volume source component is not a directory")
		}
	}

	baseMountPath := filepath.Join(rootPath, volumeMountPrefix+vol.VolumeId)
	bindSource := filepath.Join(rootPath, relativeSource)
	resolvedSource, err := filepath.EvalSymlinks(bindSource)
	if err != nil || resolvedSource != bindSource {
		return "", "", fmt.Errorf("local volume source must be canonical and contain no symbolic link")
	}
	return baseMountPath, bindSource, nil
}

func (d *DockerClient) getVolumesMountPathBinds(ctx context.Context, volumes []dto.VolumeDTO) ([]string, error) {
	if err := validateLocalVolumePair(volumes); err != nil {
		return nil, err
	}

	volumeMountPathBinds := make([]string, 0, len(volumes))
	for _, vol := range volumes {
		_, bindSource, err := d.resolveVolumeMountPaths(vol)
		if err != nil {
			return nil, err
		}
		subpathStr := ""
		if vol.Subpath != nil {
			subpathStr = *vol.Subpath
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
