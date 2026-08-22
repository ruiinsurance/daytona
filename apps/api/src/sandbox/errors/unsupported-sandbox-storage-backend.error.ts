/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, HttpStatus } from '@nestjs/common'
import { SandboxStorageBackend } from '../enums/sandbox-storage-backend.enum'

export class UnsupportedSandboxStorageBackendError extends ConflictException {
  constructor(storageBackend: SandboxStorageBackend) {
    super({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      message: 'Only Runner-local sandbox storage is supported',
      code: 'sandbox_storage_backend_unsupported',
      storageBackend,
    })
  }
}
