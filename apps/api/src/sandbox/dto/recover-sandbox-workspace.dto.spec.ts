/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { RecoverSandboxWorkspaceDto } from './recover-sandbox-workspace.dto'

const valid = {
  operationId: '11111111-1111-4111-8111-111111111111',
  ownerRunnerId: '22222222-2222-4222-8222-222222222222',
  workspace: {
    volumeId: '33333333-3333-4333-8333-333333333333',
    mountPath: '/workspace',
    subpath: 'sandboxes/44444444-4444-4444-8444-444444444444/workspace',
  },
}

describe('RecoverSandboxWorkspaceDto', () => {
  it('accepts the exact typed recovery request shape', async () => {
    await expect(validate(plainToInstance(RecoverSandboxWorkspaceDto, valid))).resolves.toEqual([])
  })

  it.each([
    { ...valid, operationId: 'not-a-uuid' },
    { ...valid, ownerRunnerId: 'not-a-uuid' },
    { ...valid, workspace: { ...valid.workspace, volumeId: 'not-a-uuid' } },
    { ...valid, workspace: { ...valid.workspace, mountPath: '/config' } },
  ])('rejects malformed identity or mount input', async (input) => {
    const errors = await validate(plainToInstance(RecoverSandboxWorkspaceDto, input))
    expect(errors.length).toBeGreaterThan(0)
  })
})
