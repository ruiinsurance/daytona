// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package localfirst

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

type fakeNotifier struct {
	mu       sync.Mutex
	events   []DirtyEvent
	started  chan struct{}
	response error
}

func (n *fakeNotifier) MarkDirty(_ context.Context, event DirtyEvent) error {
	n.mu.Lock()
	n.events = append(n.events, event)
	n.mu.Unlock()
	if n.started != nil {
		select {
		case n.started <- struct{}{}:
		default:
		}
	}
	return n.response
}

type fakeFileWatcher struct {
	events chan fsnotify.Event
	errors chan error
	added  []string
	closed bool
	mu     sync.Mutex
}

func (w *fakeFileWatcher) Add(path string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.added = append(w.added, path)
	return nil
}

func (w *fakeFileWatcher) Events() <-chan fsnotify.Event { return w.events }

func (w *fakeFileWatcher) Errors() <-chan error { return w.errors }

func (w *fakeFileWatcher) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.closed {
		close(w.events)
		close(w.errors)
		w.closed = true
	}
	return nil
}

func TestWorkspaceWatcherCoalescesWorkspaceEventsAndWatchesOneCanonicalSource(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "nodes", testNodeID, "volumes", testVolumeID, "sandboxes", testSandboxID, "workspace")
	if err := os.MkdirAll(workspace, 0o770); err != nil {
		t.Fatal(err)
	}
	watcher := &fakeFileWatcher{events: make(chan fsnotify.Event, 8), errors: make(chan error, 1)}
	notifier := &fakeNotifier{started: make(chan struct{}, 1)}
	service := NewWorkspaceWatcher(slog.Default(), notifier, WorkspaceWatcherOptions{
		Debounce:      20 * time.Millisecond,
		NotifyTimeout: 100 * time.Millisecond,
		NewWatcher: func() (FileWatcher, error) {
			return watcher, nil
		},
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := service.Start(ctx, WorkspaceWatchSpec{
		WorkspacePath: workspace,
		StorageRoot:   root,
		NodeID:        testNodeID,
		VolumeID:      testVolumeID,
		SandboxID:     testSandboxID,
	}); err != nil {
		t.Fatal(err)
	}

	watcher.events <- fsnotify.Event{Name: filepath.Join(workspace, "state.db"), Op: fsnotify.Write}
	watcher.events <- fsnotify.Event{Name: filepath.Join(workspace, "state.db-wal"), Op: fsnotify.Write}
	select {
	case <-notifier.started:
	case <-time.After(time.Second):
		t.Fatal("dirty notification did not arrive")
	}
	time.Sleep(40 * time.Millisecond)

	notifier.mu.Lock()
	got := append([]DirtyEvent(nil), notifier.events...)
	notifier.mu.Unlock()
	if len(got) != 1 {
		t.Fatalf("notification count = %d, want 1", len(got))
	}
	if got[0].VolumeID != testVolumeID || got[0].SandboxID != testSandboxID || got[0].NodeID != testNodeID {
		t.Fatalf("unexpected dirty event: %#v", got[0])
	}
	if len(watcher.added) != 1 || watcher.added[0] != workspace {
		t.Fatalf("watched paths = %#v, want only canonical workspace", watcher.added)
	}

	service.Stop(testSandboxID)
	if err := service.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestWorkspaceWatcherRejectsNonCanonicalWorkspacePath(t *testing.T) {
	notifier := &fakeNotifier{}
	service := NewWorkspaceWatcher(slog.Default(), notifier, WorkspaceWatcherOptions{
		NewWatcher: func() (FileWatcher, error) {
			return &fakeFileWatcher{events: make(chan fsnotify.Event), errors: make(chan error)}, nil
		},
	})

	err := service.Start(context.Background(), WorkspaceWatchSpec{
		WorkspacePath: "/tmp/other",
		StorageRoot:   "/srv/kortix-storage",
		NodeID:        testNodeID,
		VolumeID:      testVolumeID,
		SandboxID:     testSandboxID,
	})
	if !errors.Is(err, ErrInvalidWorkspaceWatchPath) {
		t.Fatalf("error = %v, want ErrInvalidWorkspaceWatchPath", err)
	}
}

func TestWorkspaceWatcherRetriesBoundedNotificationAndStops(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "nodes", testNodeID, "volumes", testVolumeID, "sandboxes", testSandboxID, "workspace")
	if err := os.MkdirAll(workspace, 0o770); err != nil {
		t.Fatal(err)
	}
	watcher := &fakeFileWatcher{events: make(chan fsnotify.Event, 1), errors: make(chan error, 1)}
	notifier := &fakeNotifier{response: errors.New("temporary")}
	service := NewWorkspaceWatcher(slog.Default(), notifier, WorkspaceWatcherOptions{
		Debounce:      5 * time.Millisecond,
		NotifyTimeout: 20 * time.Millisecond,
		RetryDelay:    5 * time.Millisecond,
		MaxAttempts:   2,
		NewWatcher: func() (FileWatcher, error) {
			return watcher, nil
		},
	})
	if err := service.Start(context.Background(), WorkspaceWatchSpec{
		WorkspacePath: workspace,
		StorageRoot:   root,
		NodeID:        testNodeID,
		VolumeID:      testVolumeID,
		SandboxID:     testSandboxID,
	}); err != nil {
		t.Fatal(err)
	}
	watcher.events <- fsnotify.Event{Name: filepath.Join(workspace, "file"), Op: fsnotify.Create}
	time.Sleep(80 * time.Millisecond)

	notifier.mu.Lock()
	attempts := len(notifier.events)
	notifier.mu.Unlock()
	if attempts != 2 {
		t.Fatalf("notification attempts = %d, want bounded retry count 2", attempts)
	}
	service.Stop(testSandboxID)
	if err := service.Close(); err != nil {
		t.Fatal(err)
	}
}

const (
	testNodeID    = "11111111-1111-4111-8111-111111111111"
	testVolumeID  = "22222222-2222-4222-8222-222222222222"
	testSandboxID = "33333333-3333-4333-8333-333333333333"
)
