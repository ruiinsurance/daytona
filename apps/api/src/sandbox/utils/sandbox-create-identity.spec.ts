/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { describe, expect, it } from 'vitest'
import { shouldUseWarmPoolForCreate } from './sandbox-create-identity'

describe('shouldUseWarmPoolForCreate', () => {
  it.each([
    [{ suppliedId: undefined, gpu: 0, hasLinkedSandbox: false, volumeCount: 0 }, true],
    [{ suppliedId: '11111111-1111-4111-8111-111111111111', gpu: 0, hasLinkedSandbox: false, volumeCount: 0 }, false],
    [{ suppliedId: undefined, gpu: 1, hasLinkedSandbox: false, volumeCount: 0 }, false],
    [{ suppliedId: undefined, gpu: 0, hasLinkedSandbox: true, volumeCount: 0 }, false],
    [{ suppliedId: undefined, gpu: 0, hasLinkedSandbox: false, volumeCount: 1 }, false],
  ])('returns %s for %o', (input, expected) => {
    expect(shouldUseWarmPoolForCreate(input)).toBe(expected)
  })
})
