// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package apiclient

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/daytonaio/runner/pkg/localfirst"
	"github.com/google/uuid"
)

type WorkspaceDirtyClient struct {
	baseURL string
	token   string
	client  *http.Client
}

func NewWorkspaceDirtyClient(baseURL string, token string) *WorkspaceDirtyClient {
	return &WorkspaceDirtyClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		client:  &http.Client{Timeout: 5 * time.Second},
	}
}

func (c *WorkspaceDirtyClient) MarkDirty(ctx context.Context, event localfirst.DirtyEvent) error {
	if !isCanonicalUUID(event.NodeID) || !isCanonicalUUID(event.VolumeID) || !isCanonicalUUID(event.SandboxID) {
		return errors.New("workspace_dirty_request_invalid")
	}
	if c == nil || c.client == nil || c.baseURL == "" || c.token == "" {
		return errors.New("workspace_dirty_request_invalid")
	}

	endpoint, err := url.JoinPath(c.baseURL, "storage-nodes", event.NodeID, "workspaces", "dirty")
	if err != nil {
		return errors.New("workspace_dirty_request_invalid")
	}
	body, err := json.Marshal(struct {
		VolumeID  string `json:"volumeId"`
		SandboxID string `json:"sandboxId"`
	}{
		VolumeID:  event.VolumeID,
		SandboxID: event.SandboxID,
	})
	if err != nil {
		return errors.New("workspace_dirty_request_invalid")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return errors.New("workspace_dirty_request_failed")
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(DaytonaSourceHeader, "runner")

	response, err := c.client.Do(request)
	if err != nil {
		return errors.New("workspace_dirty_request_failed")
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return errors.New("workspace_dirty_request_rejected")
	}
	return nil
}

func isCanonicalUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == value
}
