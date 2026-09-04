/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package executor

import "github.com/daytonaio/runner/pkg/api/dto"

type StartSandboxPayload struct {
	AuthToken *string           `json:"authToken,omitempty"`
	Metadata  map[string]string `json:"metadata,omitempty"`
}

type SnapshotSandboxPayload struct {
	SandboxId      string           `json:"sandboxId"`
	Name           string           `json:"name"`
	OrganizationId string           `json:"organizationId"`
	Registry       *dto.RegistryDTO `json:"registry,omitempty"`
}

type DestroySandboxWorkspacePayload struct {
	OperationID   string `json:"operationId"`
	OwnerRunnerID string `json:"ownerRunnerId"`
	VolumeID      string `json:"volumeId"`
	Subpath       string `json:"subpath"`
}

type RecoverSandboxWorkspacePayload struct {
	OperationID           string               `json:"operationId"`
	OwnerRunnerID         string               `json:"ownerRunnerId"`
	OriginalVolumeID      string               `json:"originalVolumeId"`
	OriginalVolumeSubpath string               `json:"originalVolumeSubpath"`
	Sandbox               dto.CreateSandboxDTO `json:"sandbox"`
}
