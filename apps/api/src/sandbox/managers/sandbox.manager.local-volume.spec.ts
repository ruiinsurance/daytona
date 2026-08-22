/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import 'reflect-metadata'
import { Not, type FindOptionsWhere } from 'typeorm'
import { Sandbox } from '../entities/sandbox.entity'
import { SandboxStorageBackend } from '../enums/sandbox-storage-backend.enum'
import { SandboxManager } from './sandbox.manager'

const ownerId = '22222222-2222-4222-8222-222222222222'

function createManager() {
  const sandboxRepository = { find: jest.fn().mockResolvedValue([]) }
  const manager = new SandboxManager(
    sandboxRepository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { get: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
  return { manager, sandboxRepository }
}

function expectLocalExcluded(where: FindOptionsWhere<Sandbox>): void {
  expect(where.storageBackend).toEqual(Not(SandboxStorageBackend.LOCAL))
}

describe('SandboxManager local draining exclusions', () => {
  it('excludes local sandboxes from every generic drain stop, archive, and backup-retry query', async () => {
    const { manager, sandboxRepository } = createManager()
    const drainMethods = manager as unknown as {
      forceStopStartedSandboxesOnDrainingRunner: (runnerId: string) => Promise<void>
      archiveStoppedSandboxesOnDrainingRunner: (runnerId: string) => Promise<void>
      archiveErroredSandboxesOnDrainingRunner: (runnerId: string) => Promise<void>
      retryErroredBackupsOnDrainingRunner: (runnerId: string) => Promise<void>
    }

    await drainMethods.forceStopStartedSandboxesOnDrainingRunner(ownerId)
    await drainMethods.archiveStoppedSandboxesOnDrainingRunner(ownerId)
    await drainMethods.archiveErroredSandboxesOnDrainingRunner(ownerId)
    await drainMethods.retryErroredBackupsOnDrainingRunner(ownerId)

    expect(sandboxRepository.find).toHaveBeenCalledTimes(4)
    expectLocalExcluded(sandboxRepository.find.mock.calls[0][0].where)
    expectLocalExcluded(sandboxRepository.find.mock.calls[1][0].where)
    expectLocalExcluded(sandboxRepository.find.mock.calls[2][0].where)
    const backupRetryWhere = sandboxRepository.find.mock.calls[3][0].where as FindOptionsWhere<Sandbox>[]
    expect(backupRetryWhere).toHaveLength(2)
    backupRetryWhere.forEach(expectLocalExcluded)
  })
})
