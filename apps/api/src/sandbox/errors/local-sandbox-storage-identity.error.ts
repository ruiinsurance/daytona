/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, HttpStatus } from '@nestjs/common'

export class LocalSandboxStorageIdentityError extends ConflictException {
  constructor() {
    super({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      message: 'The sandbox local Volume or mount identity could not be verified',
      code: 'storage_identity_invalid',
    })
  }
}
