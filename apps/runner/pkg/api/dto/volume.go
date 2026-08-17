// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package dto

type VolumeDTO struct {
	VolumeId       string  `json:"volumeId"`
	MountPath      string  `json:"mountPath"`
	Subpath        *string `json:"subpath,omitempty"`
	Backend        string  `json:"backend,omitempty"`
	NodeId         string  `json:"nodeId,omitempty"`
	FenceEpoch     string  `json:"fenceEpoch,omitempty"`
	LeaseOwner     string  `json:"leaseOwner,omitempty"`
	LeaseExpiresAt string  `json:"leaseExpiresAt,omitempty"`
}
