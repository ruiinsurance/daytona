// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package storageagent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
)

const (
	testNodeID    = "11111111-1111-4111-8111-111111111111"
	testVolumeID  = "22222222-2222-4222-8222-222222222222"
	testSandboxID = "33333333-3333-4333-8333-333333333333"
	testOperation = "44444444-4444-4444-8444-444444444444"
)

func TestCheckpointIsImmutableAndReused(t *testing.T) {
	root := t.TempDir()
	defer makeTreeWritable(root)
	agent, err := New(Config{Root: root, NodeID: testNodeID})
	if err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(root, "nodes", testNodeID, "volumes", testVolumeID, "sandboxes", testSandboxID, "workspace")
	if err := os.MkdirAll(workspace, 0o770); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "state.db"), []byte("before"), 0o660); err != nil {
		t.Fatal(err)
	}

	request := checkpointRequest("1")
	first, err := agent.Checkpoint(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "state.db"), []byte("after"), 0o660); err != nil {
		t.Fatal(err)
	}
	second, err := agent.Checkpoint(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(first.Objects[0].Body); got != "before" {
		t.Fatalf("first checkpoint body = %q", got)
	}
	if got := string(second.Objects[0].Body); got != "before" {
		t.Fatalf("retry checkpoint body = %q", got)
	}
	if first.Manifest != second.Manifest {
		t.Fatalf("checkpoint manifest changed across retry")
	}
}

func TestImportVerifyAndRetainAreIdempotent(t *testing.T) {
	sourceRoot := t.TempDir()
	targetRoot := t.TempDir()
	defer makeTreeWritable(sourceRoot)
	defer makeTreeWritable(targetRoot)
	source, err := New(Config{Root: sourceRoot, NodeID: testNodeID})
	if err != nil {
		t.Fatal(err)
	}
	targetNodeID := "55555555-5555-4555-8555-555555555555"
	target, err := New(Config{Root: targetRoot, NodeID: targetNodeID})
	if err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(sourceRoot, "nodes", testNodeID, "volumes", testVolumeID, "sandboxes", testSandboxID, "workspace")
	if err := os.MkdirAll(workspace, 0o770); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "state.db"), []byte("state"), 0o660); err != nil {
		t.Fatal(err)
	}
	checkpoint, err := source.Checkpoint(context.Background(), checkpointRequest("7"))
	if err != nil {
		t.Fatal(err)
	}

	importRequest := ImportRequest{
		OperationID:    testOperation,
		VolumeID:       testVolumeID,
		SandboxID:      testSandboxID,
		NodeID:         targetNodeID,
		Generation:     checkpoint.Generation,
		Manifest:       checkpoint.Manifest,
		Objects:        checkpoint.Objects,
		FenceEpoch:     "8",
		LeaseOwner:     "move-worker:" + testOperation,
		LeaseExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano),
	}
	if err := target.Import(context.Background(), importRequest); err != nil {
		t.Fatal(err)
	}
	if err := target.Import(context.Background(), importRequest); err != nil {
		t.Fatal(err)
	}
	verified, err := target.Verify(context.Background(), VerifyRequest{
		OperationID:    testOperation,
		VolumeID:       testVolumeID,
		SandboxID:      testSandboxID,
		NodeID:         targetNodeID,
		Generation:     checkpoint.Generation,
		Manifest:       checkpoint.Manifest,
		FenceEpoch:     "8",
		LeaseOwner:     "move-worker:" + testOperation,
		LeaseExpiresAt: importRequest.LeaseExpiresAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	if verified.ManifestHash == "" || len(verified.ManifestHash) != sha256.Size*2 {
		t.Fatalf("unexpected manifest hash %q", verified.ManifestHash)
	}
	if _, err := source.Retain(context.Background(), RetainRequest{
		OperationID:    testOperation,
		VolumeID:       testVolumeID,
		SandboxID:      testSandboxID,
		NodeID:         testNodeID,
		Generation:     checkpoint.Generation,
		FenceEpoch:     "7",
		LeaseOwner:     "move-worker:" + testOperation,
		LeaseExpiresAt: importRequest.LeaseExpiresAt,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(sourceRoot, "retained", testOperation+".json")); err != nil {
		t.Fatal(err)
	}
}

func TestRejectsSymlinkAndStaleLease(t *testing.T) {
	root := t.TempDir()
	agent, err := New(Config{Root: root, NodeID: testNodeID})
	if err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	workspace := filepath.Join(root, "nodes", testNodeID, "volumes", testVolumeID, "sandboxes", testSandboxID, "workspace")
	if err := os.MkdirAll(filepath.Dir(workspace), 0o770); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, workspace); err != nil {
		t.Fatal(err)
	}
	request := checkpointRequest("1")
	request.LeaseExpiresAt = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	if _, err := agent.Checkpoint(context.Background(), request); err == nil {
		t.Fatal("expected stale lease rejection")
	}
	request.LeaseExpiresAt = time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	if _, err := agent.Checkpoint(context.Background(), request); err == nil {
		t.Fatal("expected symlink rejection")
	}
}

func TestFenceRejectsStaleWriterAfterOwnerSwitch(t *testing.T) {
	root := t.TempDir()
	defer makeTreeWritable(root)
	agent, err := New(Config{Root: root, NodeID: testNodeID})
	if err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(root, "nodes", testNodeID, "volumes", testVolumeID, "sandboxes", testSandboxID, "workspace")
	if err := os.MkdirAll(workspace, 0o770); err != nil {
		t.Fatal(err)
	}

	initial := checkpointRequest("1")
	initial.FenceEpoch = "1"
	if _, err := agent.Checkpoint(context.Background(), initial); err != nil {
		t.Fatal(err)
	}
	if err := agent.Fence(context.Background(), FenceRequest{
		OperationID:    testOperation,
		VolumeID:       testVolumeID,
		SandboxID:      testSandboxID,
		NodeID:         testNodeID,
		FenceEpoch:     "2",
		LeaseOwner:     "move-worker:" + testOperation,
		LeaseExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatal(err)
	}
	replacement, err := New(Config{Root: root, NodeID: testNodeID})
	if err != nil {
		t.Fatal(err)
	}

	stale := StartRequest{
		OperationID:    testOperation,
		VolumeID:       testVolumeID,
		SandboxID:      testSandboxID,
		NodeID:         testNodeID,
		FenceEpoch:     "1",
		LeaseOwner:     "runner:stale",
		LeaseExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano),
	}
	if err := replacement.Start(context.Background(), stale); Code(err) != "stale_workspace_fence" {
		t.Fatalf("stale start error = %q, want stale_workspace_fence", Code(err))
	}

	stale.FenceEpoch = "2"
	if err := replacement.Start(context.Background(), stale); err != nil {
		t.Fatalf("current fence start failed: %v", err)
	}
}

func TestNormalStartRejectsQuiesceBarrier(t *testing.T) {
	root := t.TempDir()
	agent, err := New(Config{Root: root, NodeID: testNodeID})
	if err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(root, "nodes", testNodeID, "volumes", testVolumeID, "sandboxes", testSandboxID, "workspace")
	if err := os.MkdirAll(workspace, 0o770); err != nil {
		t.Fatal(err)
	}
	request := QuiesceRequest{
		OperationID:    testOperation,
		VolumeID:       testVolumeID,
		SandboxID:      testSandboxID,
		NodeID:         testNodeID,
		FenceEpoch:     "1",
		LeaseOwner:     "move-worker:" + testOperation,
		LeaseExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano),
	}
	if err := agent.Quiesce(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if err := agent.Start(context.Background(), StartRequest{
		OperationID:    request.OperationID,
		VolumeID:       request.VolumeID,
		SandboxID:      request.SandboxID,
		NodeID:         request.NodeID,
		FenceEpoch:     request.FenceEpoch,
		LeaseOwner:     "runner:queued",
		LeaseExpiresAt: request.LeaseExpiresAt,
	}); Code(err) != "workspace_quiesce_conflict" {
		t.Fatalf("quiesced start error = %q, want workspace_quiesce_conflict", Code(err))
	}
}

func checkpointRequest(generation string) CheckpointRequest {
	return CheckpointRequest{
		OperationID:    testOperation,
		VolumeID:       testVolumeID,
		SandboxID:      testSandboxID,
		NodeID:         testNodeID,
		Generation:     generation,
		FenceEpoch:     "7",
		LeaseOwner:     "move-worker:" + testOperation,
		LeaseExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano),
	}
}

func TestManifestHashUsesStableHex(t *testing.T) {
	manifest := Manifest{
		FormatVersion: 1,
		VolumeID:      testVolumeID,
		SandboxID:     testSandboxID,
		Generation:    "1",
		ObjectCount:   0,
		Bytes:         0,
		ContentHash:   hex.EncodeToString(make([]byte, sha256.Size)),
		CreatedAt:     "2026-08-17T00:00:00.000Z",
	}
	if got := ManifestHash(manifest); len(got) != sha256.Size*2 {
		t.Fatalf("manifest hash length = %d", len(got))
	}
	if _, err := uuid.Parse(testOperation); err != nil {
		t.Fatal(err)
	}
}

func makeTreeWritable(root string) {
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			_ = os.Chmod(path, 0o750)
		} else {
			_ = os.Chmod(path, 0o640)
		}
		return nil
	})
}
