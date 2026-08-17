// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package storage

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/daytonaio/daytona/cli/apiclient"
	"github.com/daytonaio/daytona/cli/internal"
	"github.com/spf13/cobra"
)

var (
	operationID        string
	placementID        string
	volumeID           string
	sourceNodeID       string
	targetNodeID       string
	expectedFenceEpoch string
	idempotencyKey     string
)

var canonicalUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

var StorageCmd = &cobra.Command{
	Use:     "storage",
	Short:   "Manage local-first storage through the Daytona control plane",
	Aliases: []string{"storages"},
	GroupID: internal.SANDBOX_GROUP,
}

var nodeCmd = &cobra.Command{
	Use:   "node",
	Short: "Manage storage node lifecycle",
}

func init() {
	for _, action := range []string{"status", "activate", "cordon", "drain", "remove"} {
		actionName := action
		nodeCmd.AddCommand(&cobra.Command{
			Use:   actionName + " [RUNNER_ID] [NODE_ID]",
			Short: actionName + " a storage node through the control plane",
			Args:  cobra.ExactArgs(2),
			RunE: func(cmd *cobra.Command, args []string) error {
				if !canonicalUUID.MatchString(args[0]) || !canonicalUUID.MatchString(args[1]) {
					return fmt.Errorf("runner and storage node IDs must be canonical UUIDs")
				}
				method := http.MethodPost
				endpoint := "/runners/" + args[0] + "/storage-nodes/" + args[1] + "/" + actionName
				if actionName == "status" {
					method = http.MethodGet
					endpoint = "/runners/" + args[0] + "/storage-nodes/" + args[1]
				}
				return requestStorageControlPlane(cmd.Context(), method, endpoint, nil, cmd.OutOrStdout())
			},
		})
	}

	moveCmd.Flags().StringVar(&operationID, "operation-id", "", "idempotent move operation UUID")
	moveCmd.Flags().StringVar(&placementID, "placement-id", "", "workspace placement UUID")
	moveCmd.Flags().StringVar(&volumeID, "volume-id", "", "workspace volume UUID")
	moveCmd.Flags().StringVar(&sourceNodeID, "source-node-id", "", "current owner node UUID")
	moveCmd.Flags().StringVar(&targetNodeID, "target-node-id", "", "verified target node UUID")
	moveCmd.Flags().StringVar(&expectedFenceEpoch, "fence-epoch", "", "current fencing epoch")
	moveCmd.Flags().StringVar(&idempotencyKey, "idempotency-key", "", "retry key for this move request")
	StorageCmd.AddCommand(nodeCmd, moveCmd)
}

var moveCmd = &cobra.Command{
	Use:   "move [SANDBOX_ID]",
	Short: "Request a workspace move through the control plane",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !canonicalUUID.MatchString(args[0]) {
			return fmt.Errorf("sandbox ID must be a canonical UUID")
		}
		if operationID == "" || placementID == "" || volumeID == "" || sourceNodeID == "" || targetNodeID == "" || expectedFenceEpoch == "" || idempotencyKey == "" {
			return fmt.Errorf("operation-id, placement-id, volume-id, source-node-id, target-node-id, fence-epoch, and idempotency-key are required")
		}
		for name, value := range map[string]string{
			"operation-id":   operationID,
			"placement-id":   placementID,
			"volume-id":      volumeID,
			"source-node-id": sourceNodeID,
			"target-node-id": targetNodeID,
		} {
			if !canonicalUUID.MatchString(value) {
				return fmt.Errorf("%s must be a canonical UUID", name)
			}
		}
		return requestStorageControlPlane(cmd.Context(), http.MethodPost, "/storage-workspaces/"+args[0]+"/move", map[string]string{
			"operationId":        operationID,
			"placementId":        placementID,
			"volumeId":           volumeID,
			"sourceNodeId":       sourceNodeID,
			"targetNodeId":       targetNodeID,
			"expectedFenceEpoch": expectedFenceEpoch,
			"idempotencyKey":     idempotencyKey,
		}, cmd.OutOrStdout())
	},
}

func requestStorageControlPlane(ctx context.Context, method string, endpoint string, body any, output io.Writer) error {
	requestCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	client, err := apiclient.GetApiClient(nil, nil)
	if err != nil {
		return err
	}
	baseURL, err := client.GetConfig().ServerURL(0, nil)
	if err != nil {
		return fmt.Errorf("control-plane URL unavailable")
	}
	requestURL := strings.TrimRight(baseURL, "/") + endpoint
	var reader io.Reader
	if body != nil {
		encoded, marshalErr := json.Marshal(body)
		if marshalErr != nil {
			return fmt.Errorf("control-plane request encoding failed")
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(requestCtx, method, requestURL, reader)
	if err != nil {
		return fmt.Errorf("control-plane request creation failed")
	}
	for key, value := range client.GetConfig().DefaultHeader {
		request.Header.Set(key, value)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	httpClient := client.GetConfig().HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("control-plane request failed")
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		_, _ = io.Copy(io.Discard, response.Body)
		return fmt.Errorf("control-plane request rejected: status_%d", response.StatusCode)
	}
	result, err := io.ReadAll(response.Body)
	if err != nil {
		return fmt.Errorf("control-plane response read failed")
	}
	if len(bytes.TrimSpace(result)) == 0 {
		return nil
	}
	var decoded any
	if err := json.Unmarshal(result, &decoded); err != nil {
		return fmt.Errorf("control-plane response was not JSON")
	}
	return json.NewEncoder(output).Encode(decoded)
}
