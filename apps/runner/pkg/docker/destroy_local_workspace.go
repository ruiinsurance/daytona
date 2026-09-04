// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package docker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/containerd/errdefs"
	"github.com/daytonaio/runner/pkg/api/dto"
	"github.com/docker/docker/api/types/container"
)

type localWorkspaceRemovalOutcome string

const (
	localWorkspaceRemoved       localWorkspaceRemovalOutcome = "removed"
	localWorkspaceAlreadyAbsent localWorkspaceRemovalOutcome = "already_absent"
)

// DestroyLocalWorkspace removes one canonical local-workspace slice after
// proving that the sandbox compute and every overlapping Docker mount are gone.
func (d *DockerClient) DestroyLocalWorkspace(
	ctx context.Context,
	sandboxID string,
	volumeID string,
	subpath string,
) (localWorkspaceRemovalOutcome, error) {
	if err := d.assertSandboxComputeAbsent(ctx, sandboxID); err != nil {
		return "", err
	}
	activeMountSources, err := d.activeContainerMountSources(ctx)
	if err != nil {
		return "", err
	}

	return removeLocalWorkspace(d.localVolumeRoot, sandboxID, volumeID, subpath, activeMountSources)
}

// RecoverLocalWorkspace creates compute only after proving the exact restored
// workspace already exists and cannot overlap an existing container mount.
func (d *DockerClient) RecoverLocalWorkspace(
	ctx context.Context,
	sandbox dto.CreateSandboxDTO,
	originalVolumeID string,
	originalSubpath string,
) (string, string, error) {
	if err := d.assertSandboxComputeAbsent(ctx, sandbox.Id); err != nil {
		return "", "", err
	}
	if err := validateLocalVolumePair(sandbox.Volumes); err != nil {
		return "", "", err
	}
	var workspace *dto.VolumeDTO
	for index := range sandbox.Volumes {
		if sandbox.Volumes[index].MountPath == "/workspace" {
			workspace = &sandbox.Volumes[index]
			break
		}
	}
	if workspace == nil || workspace.Subpath == nil {
		return "", "", fmt.Errorf("recovery requires an exact local workspace")
	}
	activeMountSources, err := d.activeContainerMountSources(ctx)
	if err != nil {
		return "", "", err
	}
	originalMissing, err := probeLocalWorkspaceMissing(
		d.localVolumeRoot,
		sandbox.Id,
		originalVolumeID,
		originalSubpath,
		activeMountSources,
	)
	if err != nil {
		return "", "", err
	}
	if !originalMissing {
		return "", "", fmt.Errorf("original local workspace is still available")
	}
	if err := validateLocalWorkspaceForRecovery(
		d.localVolumeRoot,
		sandbox.Id,
		workspace.VolumeId,
		*workspace.Subpath,
		activeMountSources,
	); err != nil {
		return "", "", err
	}
	return d.Create(ctx, sandbox)
}

func probeLocalWorkspaceMissing(
	localVolumeRoot string,
	sandboxID string,
	volumeID string,
	subpath string,
	activeMountSources []string,
) (bool, error) {
	if !isCanonicalV4UUID(sandboxID) || !isValidVolumeId(volumeID) {
		return false, fmt.Errorf("invalid original local workspace identity")
	}
	if subpath != "sandboxes/"+sandboxID+"/workspace" {
		return false, fmt.Errorf("original local workspace subpath does not belong to sandbox")
	}
	rootPath, err := validateLocalVolumeRoot(localVolumeRoot)
	if err != nil {
		return false, err
	}
	relativeTarget := filepath.Join(volumeMountPrefix+volumeID, "sandboxes", sandboxID, "workspace")
	targetPath := filepath.Join(rootPath, relativeTarget)
	if filepath.Clean(targetPath) != targetPath || !pathWithin(rootPath, targetPath) || targetPath == rootPath {
		return false, fmt.Errorf("original local workspace target is not canonical")
	}
	for _, source := range activeMountSources {
		if pathsOverlap(targetPath, source) {
			return false, fmt.Errorf("original local workspace is referenced by an active container mount")
		}
	}

	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return false, fmt.Errorf("open local volume root: %w", err)
	}
	defer root.Close()
	components := strings.Split(filepath.ToSlash(relativeTarget), "/")
	for index := range components {
		componentPath := filepath.Join(components[:index+1]...)
		info, inspectErr := root.Lstat(componentPath)
		if errors.Is(inspectErr, os.ErrNotExist) {
			return true, nil
		}
		if inspectErr != nil {
			return false, fmt.Errorf("inspect original workspace component: %w", inspectErr)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return false, fmt.Errorf("original workspace path contains a symbolic link")
		}
		if !info.IsDir() {
			return false, fmt.Errorf("original workspace component is not a directory")
		}
	}
	return false, nil
}

func (d *DockerClient) assertSandboxComputeAbsent(ctx context.Context, sandboxID string) error {
	if !isCanonicalV4UUID(sandboxID) {
		return fmt.Errorf("invalid sandbox identity")
	}
	if _, err := d.apiClient.ContainerInspect(ctx, sandboxID); err == nil {
		return fmt.Errorf("sandbox compute must be destroyed before workspace operation")
	} else if !errdefs.IsNotFound(err) {
		return fmt.Errorf("inspect sandbox compute before workspace operation: %w", err)
	}
	return nil
}

func (d *DockerClient) activeContainerMountSources(ctx context.Context) ([]string, error) {
	containers, err := d.apiClient.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return nil, fmt.Errorf("list container mounts before workspace operation: %w", err)
	}
	activeMountSources := make([]string, 0)
	for _, inspected := range containers {
		for _, mount := range inspected.Mounts {
			if mount.Source != "" {
				activeMountSources = append(activeMountSources, mount.Source)
			}
		}
	}
	return activeMountSources, nil
}

func removeLocalWorkspace(
	localVolumeRoot string,
	sandboxID string,
	volumeID string,
	subpath string,
	activeMountSources []string,
) (localWorkspaceRemovalOutcome, error) {
	if !isCanonicalV4UUID(sandboxID) || !isValidVolumeId(volumeID) {
		return "", fmt.Errorf("invalid local workspace identity")
	}
	expectedSubpath := "sandboxes/" + sandboxID + "/workspace"
	if subpath != expectedSubpath {
		return "", fmt.Errorf("local workspace subpath does not belong to sandbox")
	}

	rootPath, err := validateLocalVolumeRoot(localVolumeRoot)
	if err != nil {
		return "", err
	}
	relativeTarget := filepath.Join(volumeMountPrefix+volumeID, "sandboxes", sandboxID, "workspace")
	targetPath := filepath.Join(rootPath, relativeTarget)
	if filepath.Clean(targetPath) != targetPath || !pathWithin(rootPath, targetPath) || targetPath == rootPath {
		return "", fmt.Errorf("local workspace target is not canonical")
	}
	for _, source := range activeMountSources {
		if pathsOverlap(targetPath, source) {
			return "", fmt.Errorf("local workspace is referenced by an active container mount")
		}
	}

	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return "", fmt.Errorf("open local volume root: %w", err)
	}
	defer root.Close()

	components := strings.Split(filepath.ToSlash(relativeTarget), "/")
	for index := range components {
		componentPath := filepath.Join(components[:index+1]...)
		info, inspectErr := root.Lstat(componentPath)
		if errors.Is(inspectErr, os.ErrNotExist) {
			return localWorkspaceAlreadyAbsent, nil
		}
		if inspectErr != nil {
			return "", fmt.Errorf("inspect local workspace component: %w", inspectErr)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("local workspace path contains a symbolic link")
		}
		if !info.IsDir() {
			return "", fmt.Errorf("local workspace component is not a directory")
		}
	}

	if err := root.RemoveAll(relativeTarget); err != nil {
		return "", fmt.Errorf("remove exact local workspace: %w", err)
	}
	if _, err := root.Lstat(relativeTarget); !errors.Is(err, os.ErrNotExist) {
		if err == nil {
			return "", fmt.Errorf("local workspace still exists after removal")
		}
		return "", fmt.Errorf("verify local workspace removal: %w", err)
	}
	return localWorkspaceRemoved, nil
}

func validateLocalWorkspaceForRecovery(
	localVolumeRoot string,
	sandboxID string,
	volumeID string,
	subpath string,
	activeMountSources []string,
) error {
	if !isCanonicalV4UUID(sandboxID) || !isValidVolumeId(volumeID) {
		return fmt.Errorf("invalid local workspace identity")
	}
	if subpath != "sandboxes/"+sandboxID+"/workspace" {
		return fmt.Errorf("local workspace subpath does not belong to sandbox")
	}
	rootPath, err := validateLocalVolumeRoot(localVolumeRoot)
	if err != nil {
		return err
	}
	relativeTarget := filepath.Join(volumeMountPrefix+volumeID, "sandboxes", sandboxID, "workspace")
	targetPath := filepath.Join(rootPath, relativeTarget)
	if filepath.Clean(targetPath) != targetPath || !pathWithin(rootPath, targetPath) || targetPath == rootPath {
		return fmt.Errorf("local workspace target is not canonical")
	}
	for _, source := range activeMountSources {
		if pathsOverlap(targetPath, source) {
			return fmt.Errorf("local workspace is referenced by an active container mount")
		}
	}

	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return fmt.Errorf("open local volume root: %w", err)
	}
	defer root.Close()
	components := strings.Split(filepath.ToSlash(relativeTarget), "/")
	for index := range components {
		componentPath := filepath.Join(components[:index+1]...)
		info, inspectErr := root.Lstat(componentPath)
		if inspectErr != nil {
			return fmt.Errorf("inspect restored workspace component: %w", inspectErr)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("restored workspace path contains a symbolic link")
		}
		if !info.IsDir() {
			return fmt.Errorf("restored workspace component is not a directory")
		}
	}
	workspace, err := root.Open(relativeTarget)
	if err != nil {
		return fmt.Errorf("open restored workspace: %w", err)
	}
	defer workspace.Close()
	entries, err := workspace.Readdirnames(1)
	if err != nil && !errors.Is(err, io.EOF) {
		return fmt.Errorf("inspect restored workspace contents: %w", err)
	}
	if len(entries) == 0 {
		return fmt.Errorf("restored workspace must not be empty")
	}
	return nil
}

func pathsOverlap(first string, second string) bool {
	if !filepath.IsAbs(second) {
		return false
	}
	cleanSecond := filepath.Clean(second)
	return pathWithin(first, cleanSecond) || pathWithin(cleanSecond, first)
}

func pathWithin(parent string, candidate string) bool {
	relativePath, err := filepath.Rel(parent, candidate)
	return err == nil && relativePath != ".." && !strings.HasPrefix(relativePath, ".."+string(filepath.Separator))
}
