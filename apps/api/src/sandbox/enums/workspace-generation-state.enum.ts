/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

export enum WorkspaceGenerationState {
  CHECKPOINTING = 'checkpointing',
  CHECKPOINTED = 'checkpointed',
  UPLOADING = 'uploading',
  COMMITTED = 'committed',
  FAILED = 'failed',
}
