/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package healthcheck

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	apiclient "github.com/daytonaio/daytona/libs/api-client-go"
)

func TestStorageNodeClientRegistersAndHeartbeatsWithoutLoggingResponseBodies(t *testing.T) {
	nodeID := "11111111-1111-4111-8111-111111111111"
	type requestRecord struct {
		path string
		body map[string]any
	}
	requests := make([]requestRecord, 0, 2)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		requests = append(requests, requestRecord{path: request.URL.Path, body: body})
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	config := apiclient.NewConfiguration()
	config.Servers = apiclient.ServerConfigurations{{URL: server.URL + "/api"}}
	config.AddDefaultHeader("Authorization", "Bearer test-token")
	config.HTTPClient = server.Client()
	client, err := newStorageNodeClient(apiclient.NewAPIClient(config))
	if err != nil {
		t.Fatalf("newStorageNodeClient() error = %v", err)
	}

	capacity := storageNodeCapacity{CapacityBytes: 1000, UsedBytes: 100, CapacityInodes: 200, UsedInodes: 20}
	if err := client.register(context.Background(), nodeID, capacity); err != nil {
		t.Fatalf("register() error = %v", err)
	}
	if err := client.heartbeat(context.Background(), nodeID, capacity); err != nil {
		t.Fatalf("heartbeat() error = %v", err)
	}

	if len(requests) != 2 {
		t.Fatalf("request count = %d, want 2", len(requests))
	}
	if requests[0].path != "/api/storage-nodes/register" || requests[1].path != "/api/storage-nodes/"+nodeID+"/heartbeat" {
		t.Fatalf("paths = %#v", requests)
	}
	if requests[0].body["nodeId"] != nodeID || requests[1].body["usedBytes"] != float64(100) {
		t.Fatalf("request bodies = %#v", requests)
	}
}
