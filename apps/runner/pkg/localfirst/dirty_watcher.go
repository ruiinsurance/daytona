// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package localfirst

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/google/uuid"
)

var ErrInvalidWorkspaceWatchPath = errors.New("invalid local-first workspace watch path")

type DirtyEvent struct {
	NodeID    string
	VolumeID  string
	SandboxID string
}

type DirtyNotifier interface {
	MarkDirty(context.Context, DirtyEvent) error
}

type FileWatcher interface {
	Add(string) error
	Events() <-chan fsnotify.Event
	Errors() <-chan error
	Close() error
}

type WorkspaceWatchSpec struct {
	WorkspacePath string
	StorageRoot   string
	NodeID        string
	VolumeID      string
	SandboxID     string
}

type WorkspaceWatcherOptions struct {
	Debounce      time.Duration
	NotifyTimeout time.Duration
	RetryDelay    time.Duration
	MaxAttempts   int
	NewWatcher    func() (FileWatcher, error)
}

type WorkspaceWatcher struct {
	logger   *slog.Logger
	notifier DirtyNotifier
	options  WorkspaceWatcherOptions

	mu       sync.Mutex
	sessions map[string]*workspaceWatchSession
	closed   bool
}

type workspaceWatchSession struct {
	spec     WorkspaceWatchSpec
	watcher  FileWatcher
	cancel   context.CancelFunc
	stopOnce sync.Once
	stopErr  error
}

func NewWorkspaceWatcher(logger *slog.Logger, notifier DirtyNotifier, options WorkspaceWatcherOptions) *WorkspaceWatcher {
	if logger == nil {
		logger = slog.Default()
	}
	if options.Debounce <= 0 {
		options.Debounce = 250 * time.Millisecond
	}
	if options.NotifyTimeout <= 0 {
		options.NotifyTimeout = 2 * time.Second
	}
	if options.RetryDelay <= 0 {
		options.RetryDelay = 100 * time.Millisecond
	}
	if options.MaxAttempts <= 0 {
		options.MaxAttempts = 3
	}
	if options.NewWatcher == nil {
		options.NewWatcher = func() (FileWatcher, error) {
			watcher, err := fsnotify.NewWatcher()
			if err != nil {
				return nil, err
			}
			return &fsnotifyFileWatcher{watcher: watcher}, nil
		}
	}
	return &WorkspaceWatcher{
		logger:   logger.With(slog.String("component", "local-first-workspace-watcher")),
		notifier: notifier,
		options:  options,
		sessions: make(map[string]*workspaceWatchSession),
	}
}

type fsnotifyFileWatcher struct {
	watcher *fsnotify.Watcher
}

func (w *fsnotifyFileWatcher) Add(path string) error { return w.watcher.Add(path) }

func (w *fsnotifyFileWatcher) Events() <-chan fsnotify.Event { return w.watcher.Events }

func (w *fsnotifyFileWatcher) Errors() <-chan error { return w.watcher.Errors }

func (w *fsnotifyFileWatcher) Close() error { return w.watcher.Close() }

func (w *WorkspaceWatcher) Start(ctx context.Context, spec WorkspaceWatchSpec) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if w.notifier == nil || !isCanonicalWorkspaceSpec(spec) {
		return ErrInvalidWorkspaceWatchPath
	}
	if err := validateWorkspacePath(spec); err != nil {
		return err
	}

	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return ErrInvalidWorkspaceWatchPath
	}
	previous := w.sessions[spec.SandboxID]
	delete(w.sessions, spec.SandboxID)
	w.mu.Unlock()
	if previous != nil {
		previous.stop()
	}

	fileWatcher, err := w.options.NewWatcher()
	if err != nil {
		return errors.New("workspace_watcher_create_failed")
	}
	if err := addWorkspaceDirectories(fileWatcher, spec.WorkspacePath); err != nil {
		_ = fileWatcher.Close()
		return errors.New("workspace_watcher_add_failed")
	}

	watchCtx, cancel := context.WithCancel(ctx)
	session := &workspaceWatchSession{spec: spec, watcher: fileWatcher, cancel: cancel}
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		cancel()
		_ = fileWatcher.Close()
		return ErrInvalidWorkspaceWatchPath
	}
	w.sessions[spec.SandboxID] = session
	w.mu.Unlock()
	go w.run(watchCtx, session)
	return nil
}

func (w *WorkspaceWatcher) Stop(sandboxID string) {
	w.mu.Lock()
	session := w.sessions[sandboxID]
	delete(w.sessions, sandboxID)
	w.mu.Unlock()
	if session != nil {
		session.stop()
	}
}

func (w *WorkspaceWatcher) Close() error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	w.closed = true
	sessions := make([]*workspaceWatchSession, 0, len(w.sessions))
	for sandboxID, session := range w.sessions {
		delete(w.sessions, sandboxID)
		sessions = append(sessions, session)
	}
	w.mu.Unlock()

	var firstErr error
	for _, session := range sessions {
		if err := session.stop(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (w *WorkspaceWatcher) run(ctx context.Context, session *workspaceWatchSession) {
	var (
		events   = session.watcher.Events()
		errorsCh = session.watcher.Errors()
		timer    *time.Timer
		timerCh  <-chan time.Time
		pending  bool
	)
	defer func() {
		if timer != nil {
			timer.Stop()
		}
		_ = session.stop()
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-events:
			if !ok {
				events = nil
				continue
			}
			if event.Op&fsnotify.Create != 0 {
				if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
					_ = addWorkspaceDirectories(session.watcher, event.Name)
				}
			}
			if !isDirtyEvent(event) {
				continue
			}
			pending = true
			if timer == nil {
				timer = time.NewTimer(w.options.Debounce)
			} else {
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(w.options.Debounce)
			}
			timerCh = timer.C
		case <-errorsCh:
			// The filesystem watcher error is intentionally reduced to a fixed
			// category. Periodic reconciliation remains the durability backstop.
			w.logger.WarnContext(ctx, "workspace watcher error", "code", "workspace_watcher_error")
			errorsCh = nil
		case <-timerCh:
			timerCh = nil
			if !pending {
				continue
			}
			pending = false
			w.notify(ctx, session.spec)
			if pending {
				if timer == nil {
					timer = time.NewTimer(w.options.Debounce)
				} else {
					timer.Reset(w.options.Debounce)
				}
				timerCh = timer.C
			}
		}
		if events == nil && errorsCh == nil {
			return
		}
	}
}

func (w *WorkspaceWatcher) notify(ctx context.Context, spec WorkspaceWatchSpec) {
	event := DirtyEvent{NodeID: spec.NodeID, VolumeID: spec.VolumeID, SandboxID: spec.SandboxID}
	for attempt := 1; attempt <= w.options.MaxAttempts; attempt++ {
		notifyCtx, cancel := context.WithTimeout(ctx, w.options.NotifyTimeout)
		err := w.notifier.MarkDirty(notifyCtx, event)
		cancel()
		if err == nil {
			return
		}
		if ctx.Err() != nil {
			return
		}
		if attempt < w.options.MaxAttempts {
			timer := time.NewTimer(w.options.RetryDelay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	}
	w.logger.WarnContext(ctx, "workspace dirty notification failed", "code", "workspace_dirty_notify_failed")
}

func (s *workspaceWatchSession) stop() error {
	s.stopOnce.Do(func() {
		s.cancel()
		s.stopErr = s.watcher.Close()
	})
	return s.stopErr
}

func isDirtyEvent(event fsnotify.Event) bool {
	return event.Op&(fsnotify.Write|fsnotify.Create|fsnotify.Remove|fsnotify.Rename) != 0
}

func addWorkspaceDirectories(watcher FileWatcher, root string) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			return nil
		}
		return watcher.Add(path)
	})
}

func isCanonicalWorkspaceSpec(spec WorkspaceWatchSpec) bool {
	return isCanonicalUUID(spec.NodeID) && isCanonicalUUID(spec.VolumeID) && isCanonicalUUID(spec.SandboxID)
}

func validateWorkspacePath(spec WorkspaceWatchSpec) error {
	if strings.ContainsRune(spec.StorageRoot, '\x00') || strings.ContainsRune(spec.WorkspacePath, '\x00') {
		return ErrInvalidWorkspaceWatchPath
	}
	root := filepath.Clean(spec.StorageRoot)
	workspace := filepath.Clean(spec.WorkspacePath)
	if !filepath.IsAbs(spec.StorageRoot) || root != spec.StorageRoot || !filepath.IsAbs(spec.WorkspacePath) {
		return ErrInvalidWorkspaceWatchPath
	}
	expected := filepath.Join(root, "nodes", spec.NodeID, "volumes", spec.VolumeID, "sandboxes", spec.SandboxID, "workspace")
	if workspace != expected {
		return ErrInvalidWorkspaceWatchPath
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return ErrInvalidWorkspaceWatchPath
	}
	realWorkspace, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		return ErrInvalidWorkspaceWatchPath
	}
	relative, err := filepath.Rel(realRoot, realWorkspace)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return ErrInvalidWorkspaceWatchPath
	}
	info, err := os.Stat(realWorkspace)
	if err != nil || !info.IsDir() {
		return ErrInvalidWorkspaceWatchPath
	}
	return nil
}

func isCanonicalUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == value
}
