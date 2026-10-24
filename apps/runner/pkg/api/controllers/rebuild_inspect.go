// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package controllers

import (
	"net/http"

	"github.com/daytonaio/runner/pkg/api/dto"
	"github.com/daytonaio/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

// InspectRebuildWorkspace is a read-only inspection with an expected-volume body.
// It is registered under the same authenticated middleware as other Runner APIs.
func InspectRebuildWorkspace(ctx *gin.Context) {
	var input struct {
		Volumes []dto.VolumeDTO `json:"volumes"`
	}
	if err := ctx.ShouldBindJSON(&input); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"code": "invalid_workspace_expectation"})
		return
	}
	instance, err := runner.GetInstance(nil)
	if err != nil {
		ctx.JSON(http.StatusServiceUnavailable, gin.H{"code": "inspection_unavailable"})
		return
	}
	id, created, image, err := instance.Docker.InspectRebuildWorkspace(ctx.Request.Context(), ctx.Param("sandboxId"), input.Volumes)
	if err != nil {
		ctx.JSON(http.StatusConflict, gin.H{"code": "workspace_identity_unverified"})
		return
	}
	ctx.JSON(http.StatusOK, gin.H{"sandboxId": ctx.Param("sandboxId"), "containerId": id, "created": created, "image": image, "verified": true})
}
