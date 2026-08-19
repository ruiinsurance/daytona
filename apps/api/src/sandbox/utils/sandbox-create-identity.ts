/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

export function shouldUseWarmPoolForCreate(input: {
  suppliedId?: string
  gpu: number
  hasLinkedSandbox: boolean
  volumeCount: number
}): boolean {
  return !input.suppliedId && input.gpu <= 0 && !input.hasLinkedSandbox && input.volumeCount === 0
}
