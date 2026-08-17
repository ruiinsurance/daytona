/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package healthcheck

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	apiclient "github.com/daytonaio/daytona/libs/api-client-go"
)

type storageNodeClient struct {
	baseURL     string
	httpClient  *http.Client
	defaultHead map[string]string
}

type storageNodeCapacity struct {
	CapacityBytes  uint64
	UsedBytes      uint64
	CapacityInodes uint64
	UsedInodes     uint64
}

func newStorageNodeClient(client *apiclient.APIClient) (*storageNodeClient, error) {
	baseURL, err := client.GetConfig().ServerURL(0, nil)
	if err != nil {
		return nil, fmt.Errorf("storage node API base URL unavailable")
	}
	if parsed, parseErr := url.Parse(baseURL); parseErr != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("storage node API base URL invalid")
	}
	httpClient := client.GetConfig().HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	defaultHeaders := make(map[string]string, len(client.GetConfig().DefaultHeader))
	for key, value := range client.GetConfig().DefaultHeader {
		defaultHeaders[key] = value
	}
	return &storageNodeClient{
		baseURL:     strings.TrimRight(baseURL, "/"),
		httpClient:  httpClient,
		defaultHead: defaultHeaders,
	}, nil
}

func (c *storageNodeClient) register(ctx context.Context, nodeID string, capacity storageNodeCapacity) error {
	body := map[string]any{
		"nodeId":         nodeID,
		"capacityBytes":  capacity.CapacityBytes,
		"capacityInodes": capacity.CapacityInodes,
		"labels":         map[string]string{"backend": "local-first"},
	}
	return c.do(ctx, http.MethodPost, c.baseURL+"/storage-nodes/register", body)
}

func (c *storageNodeClient) heartbeat(ctx context.Context, nodeID string, capacity storageNodeCapacity) error {
	body := map[string]any{
		"capacityBytes":  capacity.CapacityBytes,
		"usedBytes":      capacity.UsedBytes,
		"capacityInodes": capacity.CapacityInodes,
		"usedInodes":     capacity.UsedInodes,
		"labels":         map[string]string{"backend": "local-first"},
	}
	return c.do(ctx, http.MethodPost, c.baseURL+"/storage-nodes/"+nodeID+"/heartbeat", body)
}

func (c *storageNodeClient) do(ctx context.Context, method string, endpoint string, body any) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("storage node request encoding failed")
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return fmt.Errorf("storage node request creation failed")
	}
	for key, value := range c.defaultHead {
		req.Header.Set(key, value)
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("storage node request failed")
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("storage node request rejected: status_%d", response.StatusCode)
	}
	return nil
}
