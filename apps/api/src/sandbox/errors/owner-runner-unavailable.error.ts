/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpStatus, ServiceUnavailableException } from '@nestjs/common'

export class OwnerRunnerUnavailableError extends ServiceUnavailableException {
  constructor(ownerRunnerId?: string) {
    super({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      error: 'Service Unavailable',
      message: 'The local volume owner Runner is unavailable',
      code: 'owner_runner_unavailable',
      ownerRunnerId: ownerRunnerId ?? null,
    })
  }
}
