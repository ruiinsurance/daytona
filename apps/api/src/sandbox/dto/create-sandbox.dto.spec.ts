/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { describe, expect, it } from 'vitest'
import { CreateSandboxDto } from './create-sandbox.dto'

describe('CreateSandboxDto stable identity', () => {
  it('accepts a canonical lowercase v4 UUID', async () => {
    const errors = await validate(
      plainToInstance(CreateSandboxDto, {
        id: '11111111-1111-4111-8111-111111111111',
      }),
    )

    expect(errors).toHaveLength(0)
  })

  it.each([
    '11111111-1111-4111-8111-11111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase(),
    '11111111-1111-5111-8111-111111111111',
    '../11111111-1111-4111-8111-111111111111',
  ])('rejects a non-canonical id: %s', async (id) => {
    const errors = await validate(plainToInstance(CreateSandboxDto, { id }))

    expect(errors.some((error) => error.property === 'id')).toBe(true)
  })
})
