// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

// Package storageagent owns the Runner-local part of the local-first storage
// protocol. The API process may request a checkpoint or a move, but it never
// supplies a host path and never executes a host copy command itself.
package storageagent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sys/unix"
)

const (
	checkpointManifestName = ".checkpoint-manifest.json"
	maxCheckpointObjects   = 100_000
	maxCheckpointBytes     = int64(2 << 30)
)

type Config struct {
	Root   string
	NodeID string
}

type Agent struct {
	root   string
	nodeID string
	mu     sync.Mutex
}

type Error struct {
	code     string
	conflict bool
}

func (e *Error) Error() string { return e.code }

func Code(err error) string {
	var agentErr *Error
	if errors.As(err, &agentErr) {
		return agentErr.code
	}
	return "storage_agent_failed"
}

func IsConflict(err error) bool {
	var agentErr *Error
	return errors.As(err, &agentErr) && agentErr.conflict
}

type CheckpointRequest struct {
	OperationID    string `json:"operationId"`
	VolumeID       string `json:"volumeId"`
	SandboxID      string `json:"sandboxId"`
	NodeID         string `json:"nodeId"`
	Generation     string `json:"generation"`
	FenceEpoch     string `json:"fenceEpoch"`
	LeaseOwner     string `json:"leaseOwner"`
	LeaseExpiresAt string `json:"leaseExpiresAt"`
}

type ImportRequest struct {
	OperationID    string   `json:"operationId"`
	VolumeID       string   `json:"volumeId"`
	SandboxID      string   `json:"sandboxId"`
	NodeID         string   `json:"nodeId"`
	Generation     string   `json:"generation"`
	FenceEpoch     string   `json:"fenceEpoch"`
	LeaseOwner     string   `json:"leaseOwner"`
	LeaseExpiresAt string   `json:"leaseExpiresAt"`
	Manifest       Manifest `json:"manifest"`
	Objects        []Object `json:"objects"`
}

type VerifyRequest struct {
	OperationID    string   `json:"operationId"`
	VolumeID       string   `json:"volumeId"`
	SandboxID      string   `json:"sandboxId"`
	NodeID         string   `json:"nodeId"`
	Generation     string   `json:"generation"`
	FenceEpoch     string   `json:"fenceEpoch"`
	LeaseOwner     string   `json:"leaseOwner"`
	LeaseExpiresAt string   `json:"leaseExpiresAt"`
	Manifest       Manifest `json:"manifest"`
}

type StartRequest struct {
	OperationID    string `json:"operationId"`
	VolumeID       string `json:"volumeId"`
	SandboxID      string `json:"sandboxId"`
	NodeID         string `json:"nodeId"`
	FenceEpoch     string `json:"fenceEpoch"`
	LeaseOwner     string `json:"leaseOwner"`
	LeaseExpiresAt string `json:"leaseExpiresAt"`
}

type RetainRequest struct {
	OperationID    string `json:"operationId"`
	VolumeID       string `json:"volumeId"`
	SandboxID      string `json:"sandboxId"`
	NodeID         string `json:"nodeId"`
	Generation     string `json:"generation"`
	FenceEpoch     string `json:"fenceEpoch"`
	LeaseOwner     string `json:"leaseOwner"`
	LeaseExpiresAt string `json:"leaseExpiresAt"`
}

type QuiesceRequest struct {
	OperationID    string `json:"operationId"`
	VolumeID       string `json:"volumeId"`
	SandboxID      string `json:"sandboxId"`
	NodeID         string `json:"nodeId"`
	FenceEpoch     string `json:"fenceEpoch"`
	LeaseOwner     string `json:"leaseOwner"`
	LeaseExpiresAt string `json:"leaseExpiresAt"`
}

type Manifest struct {
	FormatVersion int    `json:"formatVersion"`
	VolumeID      string `json:"volumeId"`
	SandboxID     string `json:"sandboxId"`
	Generation    string `json:"generation"`
	ObjectCount   int    `json:"objectCount"`
	Bytes         int64  `json:"bytes"`
	ContentHash   string `json:"contentHash"`
	CreatedAt     string `json:"createdAt"`
}

type Object struct {
	Key    string `json:"key"`
	Body   []byte `json:"body"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Mode   uint32 `json:"mode,omitempty"`
}

type Checkpoint struct {
	Generation string   `json:"generation"`
	Manifest   Manifest `json:"manifest"`
	Objects    []Object `json:"objects"`
}

type VerifyResponse struct {
	Generation   string `json:"generation"`
	ManifestHash string `json:"manifestHash"`
}

type RetainResponse struct {
	Retained bool `json:"retained"`
}

func New(config Config) (*Agent, error) {
	if !isCanonicalUUID(config.NodeID) {
		return nil, newError("storage_node_id_invalid", false)
	}
	if config.Root == "" || !filepath.IsAbs(config.Root) || filepath.Clean(config.Root) != config.Root || strings.ContainsRune(config.Root, '\x00') {
		return nil, newError("storage_root_invalid", false)
	}
	if err := os.MkdirAll(config.Root, 0o770); err != nil {
		return nil, newError("storage_root_unavailable", false)
	}
	root, err := filepath.EvalSymlinks(config.Root)
	if err != nil || !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return nil, newError("storage_root_unavailable", false)
	}
	return &Agent{root: root, nodeID: config.NodeID}, nil
}

func (a *Agent) Checkpoint(ctx context.Context, request CheckpointRequest) (Checkpoint, error) {
	if err := a.validateRequest(ctx, request.OperationID, request.VolumeID, request.SandboxID, request.NodeID, request.FenceEpoch, request.LeaseOwner, request.LeaseExpiresAt); err != nil {
		return Checkpoint{}, err
	}
	if !isDecimal(request.Generation) {
		return Checkpoint{}, newError("generation_invalid", false)
	}
	workspace, err := a.workspacePath(request.VolumeID, request.SandboxID, request.NodeID, false)
	if err != nil {
		return Checkpoint{}, err
	}
	if err := a.rejectConflictingLock(request.VolumeID, request.SandboxID, request.OperationID); err != nil {
		return Checkpoint{}, err
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	checkpointDir := filepath.Join(a.root, "checkpoints", request.VolumeID, request.SandboxID, request.Generation)
	if existing, err := a.loadCheckpoint(checkpointDir); err == nil {
		return existing, nil
	} else if Code(err) != "checkpoint_not_found" {
		return Checkpoint{}, err
	}

	if err := ctx.Err(); err != nil {
		return Checkpoint{}, newError("storage_agent_timeout", false)
	}
	if _, err := os.Stat(workspace); err != nil {
		return Checkpoint{}, newError("workspace_not_found", false)
	}
	if err := ensureNoSymlinks(workspace); err != nil {
		return Checkpoint{}, err
	}
	if err := a.assertNoSymlinkComponents(filepath.Dir(checkpointDir)); err != nil {
		return Checkpoint{}, err
	}
	if err := os.MkdirAll(filepath.Dir(checkpointDir), 0o750); err != nil {
		return Checkpoint{}, newError("checkpoint_unavailable", false)
	}
	if err := a.assertNoSymlinkComponents(filepath.Dir(checkpointDir)); err != nil {
		return Checkpoint{}, err
	}
	staging, err := os.MkdirTemp(filepath.Dir(checkpointDir), request.Generation+".staging-")
	if err != nil {
		return Checkpoint{}, newError("checkpoint_unavailable", false)
	}
	if err := copyTree(workspace, staging); err != nil {
		return Checkpoint{}, err
	}
	objects, err := collectObjects(staging)
	if err != nil {
		return Checkpoint{}, err
	}
	manifest, err := buildManifest(request.VolumeID, request.SandboxID, request.Generation, objects)
	if err != nil {
		return Checkpoint{}, err
	}
	if err := writeJSON(filepath.Join(staging, checkpointManifestName), manifest, 0o440); err != nil {
		return Checkpoint{}, newError("checkpoint_unavailable", false)
	}
	if err := makeReadOnly(staging); err != nil {
		return Checkpoint{}, newError("checkpoint_unavailable", false)
	}
	if err := os.Rename(staging, checkpointDir); err != nil {
		if existing, loadErr := a.loadCheckpoint(checkpointDir); loadErr == nil {
			return existing, nil
		}
		return Checkpoint{}, newError("checkpoint_publish_failed", false)
	}
	return Checkpoint{Generation: request.Generation, Manifest: manifest, Objects: objects}, nil
}

func (a *Agent) Export(ctx context.Context, request CheckpointRequest) (Checkpoint, error) {
	if err := a.validateRequest(ctx, request.OperationID, request.VolumeID, request.SandboxID, request.NodeID, request.FenceEpoch, request.LeaseOwner, request.LeaseExpiresAt); err != nil {
		return Checkpoint{}, err
	}
	if !isDecimal(request.Generation) {
		return Checkpoint{}, newError("generation_invalid", false)
	}
	return a.loadCheckpoint(filepath.Join(a.root, "checkpoints", request.VolumeID, request.SandboxID, request.Generation))
}

func (a *Agent) Import(ctx context.Context, request ImportRequest) error {
	if err := a.validateRequest(ctx, request.OperationID, request.VolumeID, request.SandboxID, request.NodeID, request.FenceEpoch, request.LeaseOwner, request.LeaseExpiresAt); err != nil {
		return err
	}
	if !isDecimal(request.Generation) || request.Manifest.Generation != request.Generation {
		return newError("generation_invalid", false)
	}
	if err := validateCheckpoint(request.VolumeID, request.SandboxID, request.Generation, request.Manifest, request.Objects); err != nil {
		return err
	}
	target, err := a.workspacePath(request.VolumeID, request.SandboxID, request.NodeID, true)
	if err != nil {
		return err
	}
	if err := a.rejectConflictingLock(request.VolumeID, request.SandboxID, request.OperationID); err != nil {
		return err
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if existing, statErr := os.Stat(target); statErr == nil {
		if !existing.IsDir() {
			return newError("target_workspace_invalid", true)
		}
		actual, verifyErr := manifestForDirectory(target, request.Manifest)
		if verifyErr == nil && actual.ContentHash == request.Manifest.ContentHash && actual.ObjectCount == request.Manifest.ObjectCount && actual.Bytes == request.Manifest.Bytes {
			return nil
		}
		return newError("target_workspace_conflict", true)
	} else if !isNotFound(statErr) {
		return newError("target_workspace_unavailable", false)
	}

	transferRoot := filepath.Join(a.root, "transfers", request.OperationID)
	staging := filepath.Join(transferRoot, request.Generation)
	if err := a.assertNoSymlinkComponents(transferRoot); err != nil {
		return err
	}
	if err := os.MkdirAll(transferRoot, 0o750); err != nil {
		return newError("transfer_unavailable", false)
	}
	if err := a.assertNoSymlinkComponents(transferRoot); err != nil {
		return err
	}
	if _, err := os.Stat(staging); isNotFound(err) {
		if err := os.Mkdir(staging, 0o750); err != nil {
			return newError("transfer_unavailable", false)
		}
	} else if err != nil {
		return newError("transfer_unavailable", false)
	}
	for _, object := range request.Objects {
		if err := writeObject(staging, object); err != nil {
			return err
		}
	}
	if err := syncPath(staging); err != nil {
		return newError("transfer_sync_failed", false)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
		return newError("target_workspace_unavailable", false)
	}
	if err := os.Rename(staging, target); err != nil {
		if existing, verifyErr := a.verifyDirectory(target, request.Manifest); verifyErr == nil && existing {
			return nil
		}
		return newError("target_publish_failed", false)
	}
	return nil
}

func (a *Agent) Verify(ctx context.Context, request VerifyRequest) (VerifyResponse, error) {
	if err := a.validateRequest(ctx, request.OperationID, request.VolumeID, request.SandboxID, request.NodeID, request.FenceEpoch, request.LeaseOwner, request.LeaseExpiresAt); err != nil {
		return VerifyResponse{}, err
	}
	target, err := a.workspacePath(request.VolumeID, request.SandboxID, request.NodeID, false)
	if err != nil {
		return VerifyResponse{}, err
	}
	actual, err := manifestForDirectory(target, request.Manifest)
	if err != nil {
		return VerifyResponse{}, err
	}
	if actual.Generation != request.Generation || actual.ContentHash != request.Manifest.ContentHash || actual.ObjectCount != request.Manifest.ObjectCount || actual.Bytes != request.Manifest.Bytes {
		return VerifyResponse{}, newError("target_manifest_mismatch", true)
	}
	return VerifyResponse{Generation: request.Generation, ManifestHash: ManifestHash(request.Manifest)}, nil
}

func (a *Agent) Quiesce(ctx context.Context, request QuiesceRequest) error {
	if err := a.validateRequest(ctx, request.OperationID, request.VolumeID, request.SandboxID, request.NodeID, request.FenceEpoch, request.LeaseOwner, request.LeaseExpiresAt); err != nil {
		return err
	}
	if _, err := a.workspacePath(request.VolumeID, request.SandboxID, request.NodeID, false); err != nil {
		return err
	}
	lockPath := a.lockPath(request.VolumeID, request.SandboxID)
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o750); err != nil {
		return newError("quiesce_unavailable", false)
	}
	file, err := os.OpenFile(lockPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if err != nil {
		if !os.IsExist(err) {
			return newError("quiesce_unavailable", false)
		}
		body, readErr := os.ReadFile(lockPath)
		if readErr == nil && strings.TrimSpace(string(body)) == request.OperationID {
			return nil
		}
		return newError("workspace_quiesce_conflict", true)
	}
	if _, err := io.WriteString(file, request.OperationID+"\n"); err != nil {
		_ = file.Close()
		return newError("quiesce_unavailable", false)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return newError("quiesce_sync_failed", false)
	}
	if err := file.Close(); err != nil {
		return newError("quiesce_sync_failed", false)
	}
	unix.Sync()
	return nil
}

func (a *Agent) Start(ctx context.Context, request StartRequest) error {
	if err := a.validateRequest(ctx, request.OperationID, request.VolumeID, request.SandboxID, request.NodeID, request.FenceEpoch, request.LeaseOwner, request.LeaseExpiresAt); err != nil {
		return err
	}
	if _, err := a.workspacePath(request.VolumeID, request.SandboxID, request.NodeID, false); err != nil {
		return err
	}
	return nil
}

func (a *Agent) Retain(ctx context.Context, request RetainRequest) (RetainResponse, error) {
	if err := a.validateRequest(ctx, request.OperationID, request.VolumeID, request.SandboxID, request.NodeID, request.FenceEpoch, request.LeaseOwner, request.LeaseExpiresAt); err != nil {
		return RetainResponse{}, err
	}
	if !isDecimal(request.Generation) {
		return RetainResponse{}, newError("generation_invalid", false)
	}
	if _, err := a.workspacePath(request.VolumeID, request.SandboxID, request.NodeID, false); err != nil {
		return RetainResponse{}, err
	}
	marker := map[string]string{
		"operationId": request.OperationID,
		"volumeId":    request.VolumeID,
		"sandboxId":   request.SandboxID,
		"nodeId":      request.NodeID,
		"generation":  request.Generation,
	}
	if err := a.assertNoSymlinkComponents(filepath.Dir(filepath.Join(a.root, "retained", request.OperationID+".json"))); err != nil {
		return RetainResponse{}, err
	}
	if err := writeJSON(filepath.Join(a.root, "retained", request.OperationID+".json"), marker, 0o640); err != nil {
		return RetainResponse{}, newError("retention_evidence_failed", false)
	}
	return RetainResponse{Retained: true}, nil
}

func (a *Agent) validateRequest(ctx context.Context, operationID, volumeID, sandboxID, nodeID, fenceEpoch, leaseOwner, leaseExpiresAt string) error {
	if err := ctx.Err(); err != nil {
		return newError("storage_agent_timeout", false)
	}
	if !isCanonicalUUID(operationID) || !isCanonicalUUID(volumeID) || !isCanonicalUUID(sandboxID) || !isCanonicalUUID(nodeID) {
		return newError("storage_identity_invalid", false)
	}
	if nodeID != a.nodeID {
		return newError("storage_node_identity_mismatch", true)
	}
	if !isDecimal(fenceEpoch) || strings.TrimSpace(leaseOwner) == "" || strings.ContainsAny(leaseOwner, "\r\n") {
		return newError("workspace_fence_invalid", true)
	}
	parsed, err := time.Parse(time.RFC3339Nano, leaseExpiresAt)
	if err != nil || !parsed.After(time.Now()) {
		return newError("workspace_lease_expired", true)
	}
	return nil
}

func (a *Agent) workspacePath(volumeID, sandboxID, nodeID string, createParent bool) (string, error) {
	if !isCanonicalUUID(volumeID) || !isCanonicalUUID(sandboxID) || nodeID != a.nodeID {
		return "", newError("storage_identity_invalid", false)
	}
	path := filepath.Join(a.root, "nodes", nodeID, "volumes", volumeID, "sandboxes", sandboxID, "workspace")
	relative, err := filepath.Rel(a.root, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", newError("storage_path_escape", false)
	}
	if err := a.assertNoSymlinkComponents(filepath.Dir(path)); err != nil {
		return "", err
	}
	if createParent {
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			return "", newError("target_workspace_unavailable", false)
		}
		if err := a.assertNoSymlinkComponents(filepath.Dir(path)); err != nil {
			return "", err
		}
		return path, nil
	}
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", newError("workspace_not_found", false)
		}
		return "", newError("workspace_unavailable", false)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", newError("workspace_path_invalid", true)
	}
	realPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", newError("workspace_unavailable", false)
	}
	relative, err = filepath.Rel(a.root, realPath)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", newError("storage_path_escape", true)
	}
	return path, nil
}

func (a *Agent) assertNoSymlinkComponents(path string) error {
	cleanPath := filepath.Clean(path)
	relative, err := filepath.Rel(a.root, cleanPath)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return newError("storage_path_escape", true)
	}
	current := a.root
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
			break
		}
		if statErr != nil {
			return newError("storage_path_unavailable", false)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return newError("storage_symlink_rejected", true)
		}
	}
	return nil
}

func (a *Agent) lockPath(volumeID, sandboxID string) string {
	return filepath.Join(a.root, "locks", volumeID, sandboxID+".lock")
}

func (a *Agent) rejectConflictingLock(volumeID, sandboxID, operationID string) error {
	body, err := os.ReadFile(a.lockPath(volumeID, sandboxID))
	if isNotFound(err) {
		return nil
	}
	if err != nil {
		return newError("workspace_lock_unavailable", false)
	}
	if strings.TrimSpace(string(body)) != operationID {
		return newError("workspace_quiesce_conflict", true)
	}
	return nil
}

func (a *Agent) loadCheckpoint(path string) (Checkpoint, error) {
	manifestBody, err := os.ReadFile(filepath.Join(path, checkpointManifestName))
	if err != nil {
		if os.IsNotExist(err) {
			return Checkpoint{}, newError("checkpoint_not_found", false)
		}
		return Checkpoint{}, newError("checkpoint_unavailable", false)
	}
	var manifest Manifest
	if err := json.Unmarshal(manifestBody, &manifest); err != nil {
		return Checkpoint{}, newError("checkpoint_manifest_invalid", true)
	}
	objects, err := collectObjects(path)
	if err != nil {
		return Checkpoint{}, err
	}
	if err := validateCheckpoint(manifest.VolumeID, manifest.SandboxID, manifest.Generation, manifest, objects); err != nil {
		return Checkpoint{}, err
	}
	return Checkpoint{Generation: manifest.Generation, Manifest: manifest, Objects: objects}, nil
}

func (a *Agent) verifyDirectory(path string, expected Manifest) (bool, error) {
	actual, err := manifestForDirectory(path, expected)
	if err != nil {
		return false, err
	}
	return actual.ContentHash == expected.ContentHash && actual.ObjectCount == expected.ObjectCount && actual.Bytes == expected.Bytes, nil
}

func manifestForDirectory(path string, expected Manifest) (Manifest, error) {
	objects, err := collectObjects(path)
	if err != nil {
		return Manifest{}, err
	}
	manifest, err := buildManifest(expected.VolumeID, expected.SandboxID, expected.Generation, objects)
	if err != nil {
		return Manifest{}, err
	}
	manifest.CreatedAt = expected.CreatedAt
	return manifest, nil
}

func buildManifest(volumeID, sandboxID, generation string, objects []Object) (Manifest, error) {
	var bytes int64
	for _, object := range objects {
		bytes += object.Size
		if bytes < 0 || bytes > maxCheckpointBytes {
			return Manifest{}, newError("checkpoint_size_limit", true)
		}
	}
	return Manifest{
		FormatVersion: 1,
		VolumeID:      volumeID,
		SandboxID:     sandboxID,
		Generation:    generation,
		ObjectCount:   len(objects),
		Bytes:         bytes,
		ContentHash:   ObjectsHash(objects),
		CreatedAt:     time.Now().UTC().Format(time.RFC3339Nano),
	}, nil
}

func validateCheckpoint(volumeID, sandboxID, generation string, manifest Manifest, objects []Object) error {
	if !isCanonicalUUID(volumeID) || !isCanonicalUUID(sandboxID) || !isDecimal(generation) {
		return newError("checkpoint_identity_invalid", false)
	}
	if manifest.FormatVersion != 1 || manifest.VolumeID != volumeID || manifest.SandboxID != sandboxID || manifest.Generation != generation {
		return newError("checkpoint_manifest_invalid", true)
	}
	if len(objects) != manifest.ObjectCount || len(objects) > maxCheckpointObjects || manifest.Bytes < 0 || manifest.Bytes > maxCheckpointBytes {
		return newError("checkpoint_manifest_mismatch", true)
	}
	var bytes int64
	for _, object := range objects {
		if !safeObjectKey(object.Key) || object.Size != int64(len(object.Body)) || object.Size < 0 {
			return newError("checkpoint_object_invalid", true)
		}
		checksum := sha256.Sum256(object.Body)
		if hex.EncodeToString(checksum[:]) != object.SHA256 {
			return newError("checkpoint_object_hash_mismatch", true)
		}
		bytes += object.Size
	}
	if bytes != manifest.Bytes || ObjectsHash(objects) != manifest.ContentHash {
		return newError("checkpoint_manifest_mismatch", true)
	}
	return nil
}

func copyTree(source, target string) error {
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return newError("checkpoint_read_failed", false)
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return newError("checkpoint_read_failed", false)
		}
		if relative == "." {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return newError("checkpoint_symlink_rejected", true)
		}
		destination := filepath.Join(target, relative)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o750)
		}
		if !entry.Type().IsRegular() {
			return newError("checkpoint_special_file_rejected", true)
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return newError("checkpoint_read_failed", false)
		}
		info, err := entry.Info()
		if err != nil {
			return newError("checkpoint_read_failed", false)
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0o750); err != nil {
			return newError("checkpoint_unavailable", false)
		}
		if err := os.WriteFile(destination, body, info.Mode().Perm()); err != nil {
			return newError("checkpoint_unavailable", false)
		}
		return nil
	})
}

func collectObjects(root string) ([]Object, error) {
	objects := make([]Object, 0)
	var total int64
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return newError("checkpoint_read_failed", false)
		}
		relative, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return newError("checkpoint_read_failed", false)
		}
		if relative == "." || relative == checkpointManifestName {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return newError("checkpoint_symlink_rejected", true)
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return newError("checkpoint_special_file_rejected", true)
		}
		if len(objects) >= maxCheckpointObjects {
			return newError("checkpoint_object_limit", true)
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return newError("checkpoint_read_failed", false)
		}
		total += int64(len(body))
		if total > maxCheckpointBytes {
			return newError("checkpoint_size_limit", true)
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return newError("checkpoint_read_failed", false)
		}
		digest := sha256.Sum256(body)
		objects = append(objects, Object{
			Key:    filepath.ToSlash(relative),
			Body:   body,
			Size:   int64(len(body)),
			SHA256: hex.EncodeToString(digest[:]),
			Mode:   uint32(info.Mode().Perm()),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(objects, func(i, j int) bool { return objects[i].Key < objects[j].Key })
	return objects, nil
}

func writeObject(root string, object Object) error {
	if !safeObjectKey(object.Key) {
		return newError("checkpoint_object_invalid", true)
	}
	path := filepath.Join(root, filepath.FromSlash(object.Key))
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return newError("transfer_unavailable", false)
	}
	checksum := sha256.Sum256(object.Body)
	if int64(len(object.Body)) != object.Size || hex.EncodeToString(checksum[:]) != object.SHA256 {
		return newError("checkpoint_object_hash_mismatch", true)
	}
	mode := os.FileMode(object.Mode & 0o777)
	if mode == 0 {
		mode = 0o660
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		if !os.IsExist(err) {
			return newError("transfer_unavailable", false)
		}
		existing, readErr := os.ReadFile(path)
		if readErr == nil && string(existing) == string(object.Body) {
			return nil
		}
		return newError("transfer_object_conflict", true)
	}
	if _, err := file.Write(object.Body); err != nil {
		_ = file.Close()
		return newError("transfer_write_failed", false)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return newError("transfer_sync_failed", false)
	}
	return file.Close()
}

func writeJSON(path string, value any, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".storage-agent-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(body); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

func makeReadOnly(root string) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return os.Chmod(path, 0o550)
		}
		return os.Chmod(path, 0o440)
	})
}

func syncPath(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := file.Sync(); err != nil {
		return err
	}
	unix.Sync()
	return nil
}

func ensureNoSymlinks(root string) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return newError("workspace_read_failed", false)
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return newError("workspace_symlink_rejected", true)
		}
		return nil
	})
}

func ObjectsHash(objects []Object) string {
	copyObjects := append([]Object(nil), objects...)
	sort.Slice(copyObjects, func(i, j int) bool { return copyObjects[i].Key < copyObjects[j].Key })
	digest := sha256.New()
	for _, object := range copyObjects {
		_, _ = io.WriteString(digest, object.Key)
		_, _ = io.WriteString(digest, object.SHA256)
	}
	return hex.EncodeToString(digest.Sum(nil))
}

func ManifestHash(manifest Manifest) string {
	body, _ := json.Marshal(manifest)
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:])
}

func safeObjectKey(key string) bool {
	if key == "" || strings.HasPrefix(key, "/") || strings.ContainsRune(key, '\x00') || strings.Contains(key, "\\") {
		return false
	}
	for _, part := range strings.Split(key, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return filepath.Clean(filepath.FromSlash(key)) == filepath.FromSlash(key)
}

func newError(code string, conflict bool) error { return &Error{code: code, conflict: conflict} }

func isCanonicalUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == value
}

func isDecimal(value string) bool {
	if value == "" || (len(value) > 1 && value[0] == '0') {
		return value == "0"
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

func isNotFound(err error) bool { return errors.Is(err, os.ErrNotExist) }
