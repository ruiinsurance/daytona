// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package docker

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/daytonaio/runner/pkg/api/dto"
	"github.com/daytonaio/runner/pkg/storageagent"
	"github.com/google/uuid"
)

const (
	localFirstBackend       = "local-first"
	defaultLocalStorageRoot = "/srv/kortix-storage"
	localWorkspaceMountPath = "/workspace"
	localConfigMountPath    = "/config"
)

// resolveLocalFirstVolumeSource derives the only host path accepted for an
// online local-first workspace. The path is entirely runner-owned; the API
// supplies identity and fencing evidence, never an arbitrary host path.
func resolveLocalFirstVolumeSource(volume dto.VolumeDTO, root string, nodeID string, sandboxID string, now time.Time) (string, error) {
	if volume.Backend != localFirstBackend {
		return "", fmt.Errorf("unsupported local-first backend %q", volume.Backend)
	}
	if !isCanonicalUUID(nodeID) || volume.NodeId != nodeID {
		return "", fmt.Errorf("local-first node identity mismatch")
	}
	if !isCanonicalUUID(volume.VolumeId) || !isCanonicalUUID(sandboxID) {
		return "", fmt.Errorf("local-first workspace identity is invalid")
	}
	if volume.MountPath != localWorkspaceMountPath && volume.MountPath != localConfigMountPath {
		return "", fmt.Errorf("local-first mount path %q is not allowed", volume.MountPath)
	}
	if volume.Subpath == nil || *volume.Subpath != "sandboxes/"+sandboxID+"/workspace" {
		return "", fmt.Errorf("local-first workspace subpath is not canonical")
	}
	if volume.FenceEpoch == "" || volume.FenceEpoch[0] == '-' {
		return "", fmt.Errorf("local-first fence epoch is invalid")
	}
	for _, char := range volume.FenceEpoch {
		if char < '0' || char > '9' {
			return "", fmt.Errorf("local-first fence epoch is invalid")
		}
	}
	if strings.TrimSpace(volume.LeaseOwner) == "" || strings.ContainsAny(volume.LeaseOwner, "\r\n") {
		return "", fmt.Errorf("local-first lease owner is invalid")
	}
	leaseExpiresAt, err := time.Parse(time.RFC3339Nano, volume.LeaseExpiresAt)
	if err != nil || !leaseExpiresAt.After(now) {
		return "", fmt.Errorf("local-first lease is expired or invalid")
	}

	root, err = canonicalStorageRoot(root)
	if err != nil {
		return "", err
	}
	if err := storageagent.AssertWorkspaceStartAllowed(root, volume.VolumeId, sandboxID, volume.FenceEpoch); err != nil {
		if err.Error() == "stale_workspace_fence" {
			return "", fmt.Errorf("local-first stale workspace fence: %w", err)
		}
		return "", fmt.Errorf("local-first workspace start rejected: %w", err)
	}
	source := filepath.Join(root, "nodes", nodeID, "volumes", volume.VolumeId, "sandboxes", sandboxID, "workspace")
	relative, err := filepath.Rel(root, source)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("local-first source escapes storage root")
	}

	if err := rejectSymlinkComponents(root, source); err != nil {
		return "", err
	}
	if err := os.MkdirAll(source, 0o770); err != nil {
		return "", fmt.Errorf("create local-first source: %w", err)
	}
	if err := rejectSymlinkComponents(root, source); err != nil {
		return "", err
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("resolve local-first storage root: %w", err)
	}
	realSource, err := filepath.EvalSymlinks(source)
	if err != nil {
		return "", fmt.Errorf("resolve local-first source: %w", err)
	}
	realRelative, err := filepath.Rel(realRoot, realSource)
	if err != nil || realRelative == ".." || strings.HasPrefix(realRelative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("local-first source escapes storage root through a symlink")
	}
	return source, nil
}

func resolveLocalFirstMountSources(volumes []dto.VolumeDTO, root string, nodeID string, sandboxID string, now time.Time) (map[int]string, error) {
	sources := make(map[int]string)
	workspaceIndex := -1
	configIndex := -1
	workspaceSource := ""
	for index, volume := range volumes {
		if volume.Backend != localFirstBackend {
			continue
		}
		source, err := resolveLocalFirstVolumeSource(volume, root, nodeID, sandboxID, now)
		if err != nil {
			return nil, err
		}
		sources[index] = source
		switch volume.MountPath {
		case localWorkspaceMountPath:
			if workspaceIndex != -1 {
				return nil, fmt.Errorf("duplicate local-first /workspace mount")
			}
			workspaceIndex = index
			workspaceSource = source
		case localConfigMountPath:
			if configIndex != -1 {
				return nil, fmt.Errorf("duplicate local-first /config mount")
			}
			configIndex = index
			if source != workspaceSource && workspaceIndex != -1 {
				return nil, fmt.Errorf("local-first /workspace and /config sources differ")
			}
		}
	}
	if workspaceIndex == -1 && configIndex == -1 {
		return sources, nil
	}
	if workspaceIndex == -1 || configIndex == -1 {
		return nil, fmt.Errorf("local-first workspace requires explicit /workspace and /config binds")
	}
	if sources[configIndex] != workspaceSource {
		return nil, fmt.Errorf("local-first /workspace and /config sources differ")
	}
	return sources, nil
}

func canonicalStorageRoot(root string) (string, error) {
	if root == "" {
		root = defaultLocalStorageRoot
	}
	if !filepath.IsAbs(root) || filepath.Clean(root) != root || strings.ContainsRune(root, '\x00') {
		return "", fmt.Errorf("local-first storage root must be an absolute canonical path")
	}
	if err := os.MkdirAll(root, 0o770); err != nil {
		return "", fmt.Errorf("create local-first storage root: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("resolve local-first storage root: %w", err)
	}
	return resolved, nil
}

func rejectSymlinkComponents(root string, path string) error {
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("local-first source escapes storage root")
	}
	current := root
	if relative == "." {
		return nil
	}
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		if component == "" || component == "." {
			continue
		}
		current = filepath.Join(current, component)
		info, statErr := os.Lstat(current)
		if os.IsNotExist(statErr) {
			return nil
		}
		if statErr != nil {
			return fmt.Errorf("inspect local-first source path")
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("local-first source escapes storage root through a symlink")
		}
	}
	return nil
}

func isCanonicalUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == value
}
