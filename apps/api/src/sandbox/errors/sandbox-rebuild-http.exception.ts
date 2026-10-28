/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus } from '@nestjs/common'
import type { LocalSandboxRebuildResult } from '../services/sandbox-rebuild.service'

type RebuildFailure = Exclude<LocalSandboxRebuildResult, { outcome: 'rebuilt' }>
type EligibilityFailureCode =
  | 'control_plane_inconsistent'
  | 'remote_operation_unresolved'
  | 'historical_identity_requires_review'

/** Explicit opt-in to public rebuild evidence; never expose arbitrary exception bodies. */
export class SandboxRebuildHttpException extends HttpException {
  private readonly publicResponse: object

  constructor(
    input: (RebuildFailure & { success: false; retryable: boolean }) | { code: EligibilityFailureCode },
    status: HttpStatus,
  ) {
    // Project each field rather than spreading the service result: future internal
    // diagnostics and request/Runner credentials must stay outside the HTTP body.
    const publicResponse = 'outcome' in input
      ? {
          success: false as const,
          code: input.outcome,
          outcome: input.outcome,
          retryable: input.retryable,
          sandboxId: input.sandboxId,
          operationId: input.operationId,
          targetSnapshot: input.targetSnapshot,
          ...('ownerRunnerId' in input
            ? { ownerRunnerId: input.ownerRunnerId, previousSnapshot: input.previousSnapshot }
            : {}),
        }
      : { code: input.code }
    super(publicResponse, status)
    this.publicResponse = publicResponse
  }

  getPublicResponse(): object {
    return this.publicResponse
  }
}
