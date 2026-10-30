/* Copyright 2025 Daytona Platforms Inc. SPDX-License-Identifier: AGPL-3.0 */
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { SandboxRebuildService } from './sandbox-rebuild.service'

const sandboxId = '11111111-1111-4111-8111-111111111111'
const operationId = '22222222-2222-4222-8222-222222222222'
const organizationId = '33333333-3333-4333-8333-333333333333'
const otherOrganization = '44444444-4444-4444-8444-444444444444'
const retained = { sandboxId, operationId, organizationId, status: 'running', stage: 'mutating', targetSnapshot: 'target' }

function fixture(sandbox: unknown, record: unknown) {
  const repository = { findOne: jest.fn().mockResolvedValue(sandbox) }
  const store = { get: jest.fn().mockResolvedValue(record) }
  const lock = { getCode: jest.fn().mockResolvedValue(null) }
  const service = new SandboxRebuildService(repository as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never, lock as never, store as never)
  return { service, repository, store }
}

describe('retained rebuild evidence organization boundary', () => {
  it('permits the original organization to read its exact retained operation when the sandbox row is missing', async () => {
    const { service } = fixture(null, retained)
    const result = await service.getOperation(sandboxId, organizationId, operationId)
    expect(result).toEqual({ sandboxId, operationId, targetSnapshot: 'target', status: 'running', stage: 'mutating', executionState: 'outcome_unknown' })
    expect(result).not.toHaveProperty('organizationId')
  })

  it('does not expose orphaned evidence to another organization or when old evidence has no tenant', async () => {
    for (const record of [retained, { ...retained, organizationId: undefined }, null]) {
      const { service } = fixture(null, record)
      await expect(service.getOperation(sandboxId, otherOrganization, operationId)).rejects.toBeInstanceOf(NotFoundException)
    }
    const { service } = fixture(null, { ...retained, organizationId: undefined })
    await expect(service.getOperation(sandboxId, organizationId, operationId)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('preserves legacy reads when the matching sandbox row still exists', async () => {
    const { service } = fixture({ id: sandboxId, organizationId }, { ...retained, organizationId: undefined })
    await expect(service.getOperation(sandboxId, organizationId, operationId)).resolves.toMatchObject({ status: 'running' })
  })

  it('rejects a current foreign row or a record whose tenant conflicts with the current row', async () => {
    const foreign = fixture({ id: sandboxId, organizationId: otherOrganization }, retained)
    await expect(foreign.service.getOperation(sandboxId, organizationId, operationId)).rejects.toBeInstanceOf(NotFoundException)
    expect(foreign.store.get).not.toHaveBeenCalled()
    const conflicting = fixture({ id: sandboxId, organizationId }, { ...retained, organizationId: otherOrganization })
    await expect(conflicting.service.getOperation(sandboxId, organizationId, operationId)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('does not leak malformed or unavailable orphan evidence', async () => {
    const { service, store } = fixture(null, null)
    store.get.mockRejectedValue(new Error('private redis diagnostic'))
    await expect(service.getOperation(sandboxId, organizationId, operationId)).rejects.toBeInstanceOf(NotFoundException)
    const owned = fixture({ id: sandboxId, organizationId }, null)
    owned.store.get.mockRejectedValue(new Error('private redis diagnostic'))
    await expect(owned.service.getOperation(sandboxId, organizationId, operationId)).rejects.toBeInstanceOf(ServiceUnavailableException)
  })
})
