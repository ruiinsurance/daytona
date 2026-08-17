// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package controllers

import (
	"net/http"
	"strings"

	"github.com/daytonaio/runner/pkg/runner"
	"github.com/daytonaio/runner/pkg/storageagent"
	"github.com/gin-gonic/gin"
)

func CheckpointWorkspace(ctx *gin.Context) {
	var request storageagent.CheckpointRequest
	if err := ctx.ShouldBindJSON(&request); err != nil {
		writeStorageAgentError(ctx, "storage_agent_request_invalid", false)
		return
	}
	r, err := runner.GetInstance(nil)
	if err != nil || r.StorageAgent == nil {
		writeStorageAgentError(ctx, "storage_agent_disabled", false)
		return
	}
	checkpoint, err := r.StorageAgent.Checkpoint(ctx.Request.Context(), request)
	if err != nil {
		writeStorageAgentError(ctx, storageagent.Code(err), storageagent.IsConflict(err))
		return
	}
	ctx.JSON(http.StatusOK, checkpoint)
}

func ExportWorkspaceCheckpoint(ctx *gin.Context) {
	var request storageagent.CheckpointRequest
	if err := ctx.ShouldBindJSON(&request); err != nil {
		writeStorageAgentError(ctx, "storage_agent_request_invalid", false)
		return
	}
	r, err := runner.GetInstance(nil)
	if err != nil || r.StorageAgent == nil {
		writeStorageAgentError(ctx, "storage_agent_disabled", false)
		return
	}
	checkpoint, err := r.StorageAgent.Export(ctx.Request.Context(), request)
	if err != nil {
		writeStorageAgentError(ctx, storageagent.Code(err), storageagent.IsConflict(err))
		return
	}
	ctx.JSON(http.StatusOK, checkpoint)
}

func ImportWorkspaceCheckpoint(ctx *gin.Context) {
	var request storageagent.ImportRequest
	if err := ctx.ShouldBindJSON(&request); err != nil {
		writeStorageAgentError(ctx, "storage_agent_request_invalid", false)
		return
	}
	r, err := runner.GetInstance(nil)
	if err != nil || r.StorageAgent == nil {
		writeStorageAgentError(ctx, "storage_agent_disabled", false)
		return
	}
	if err := r.StorageAgent.Import(ctx.Request.Context(), request); err != nil {
		writeStorageAgentError(ctx, storageagent.Code(err), storageagent.IsConflict(err))
		return
	}
	ctx.JSON(http.StatusOK, gin.H{"imported": true})
}

func VerifyWorkspaceCheckpoint(ctx *gin.Context) {
	var request storageagent.VerifyRequest
	if err := ctx.ShouldBindJSON(&request); err != nil {
		writeStorageAgentError(ctx, "storage_agent_request_invalid", false)
		return
	}
	r, err := runner.GetInstance(nil)
	if err != nil || r.StorageAgent == nil {
		writeStorageAgentError(ctx, "storage_agent_disabled", false)
		return
	}
	response, err := r.StorageAgent.Verify(ctx.Request.Context(), request)
	if err != nil {
		writeStorageAgentError(ctx, storageagent.Code(err), storageagent.IsConflict(err))
		return
	}
	ctx.JSON(http.StatusOK, response)
}

func QuiesceWorkspace(ctx *gin.Context) {
	var request storageagent.QuiesceRequest
	if err := ctx.ShouldBindJSON(&request); err != nil {
		writeStorageAgentError(ctx, "storage_agent_request_invalid", false)
		return
	}
	r, err := runner.GetInstance(nil)
	if err != nil || r.StorageAgent == nil {
		writeStorageAgentError(ctx, "storage_agent_disabled", false)
		return
	}
	if err := r.StorageAgent.Quiesce(ctx.Request.Context(), request); err != nil {
		writeStorageAgentError(ctx, storageagent.Code(err), storageagent.IsConflict(err))
		return
	}
	ctx.JSON(http.StatusOK, gin.H{"quiesced": true})
}

func StartWorkspace(ctx *gin.Context) {
	var request storageagent.StartRequest
	if err := ctx.ShouldBindJSON(&request); err != nil {
		writeStorageAgentError(ctx, "storage_agent_request_invalid", false)
		return
	}
	r, err := runner.GetInstance(nil)
	if err != nil || r.StorageAgent == nil {
		writeStorageAgentError(ctx, "storage_agent_disabled", false)
		return
	}
	if err := r.StorageAgent.Start(ctx.Request.Context(), request); err != nil {
		writeStorageAgentError(ctx, storageagent.Code(err), storageagent.IsConflict(err))
		return
	}
	if r.Docker == nil {
		writeStorageAgentError(ctx, "storage_agent_start_failed", false)
		return
	}
	if err := r.Docker.StartLocalFirstWorkspace(
		ctx.Request.Context(),
		request.SandboxID,
		request.VolumeID,
		request.SandboxID,
		request.NodeID,
		request.FenceEpoch,
		request.LeaseOwner,
		request.LeaseExpiresAt,
	); err != nil {
		writeStorageAgentError(ctx, "storage_agent_start_failed", false)
		return
	}
	ctx.JSON(http.StatusOK, gin.H{"started": true})
}

func RetainWorkspaceSource(ctx *gin.Context) {
	var request storageagent.RetainRequest
	if err := ctx.ShouldBindJSON(&request); err != nil {
		writeStorageAgentError(ctx, "storage_agent_request_invalid", false)
		return
	}
	r, err := runner.GetInstance(nil)
	if err != nil || r.StorageAgent == nil {
		writeStorageAgentError(ctx, "storage_agent_disabled", false)
		return
	}
	response, err := r.StorageAgent.Retain(ctx.Request.Context(), request)
	if err != nil {
		writeStorageAgentError(ctx, storageagent.Code(err), storageagent.IsConflict(err))
		return
	}
	ctx.JSON(http.StatusOK, response)
}

func writeStorageAgentError(ctx *gin.Context, code string, conflict bool) {
	if strings.TrimSpace(code) == "" || strings.ContainsAny(code, "\r\n") {
		code = "storage_agent_failed"
	}
	status := http.StatusInternalServerError
	if conflict {
		status = http.StatusConflict
	}
	if strings.HasSuffix(code, "_invalid") || strings.HasSuffix(code, "_rejected") {
		status = http.StatusBadRequest
	}
	ctx.JSON(status, gin.H{"code": code})
}
