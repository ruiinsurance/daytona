/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import 'reflect-metadata'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { BackupState } from '../../enums/backup-state.enum'
import { SandboxDesiredState } from '../../enums/sandbox-desired-state.enum'
import { SandboxState } from '../../enums/sandbox-state.enum'
import { SandboxStorageBackend } from '../../enums/sandbox-storage-backend.enum'
import { Sandbox } from '../../entities/sandbox.entity'
import { DONT_SYNC_AGAIN } from './sandbox.action'
import { SandboxArchiveAction } from './sandbox-archive.action'

const sandboxId = '11111111-1111-4111-8111-111111111111'
const ownerId = '22222222-2222-4222-8222-222222222222'
const lockCode = { getCode: () => 'local-archive-test-lock' }

function archivedCandidate(storageBackend: SandboxStorageBackend, backupState: BackupState): Sandbox {
  return {
    id: sandboxId,
    runnerId: ownerId,
    storageBackend,
    state: SandboxState.STOPPED,
    desiredState: SandboxDesiredState.ARCHIVED,
    backupState,
    recoverable: false,
    pending: false,
  } as Sandbox
}

function createAction(params?: { sandboxInfoError?: unknown }) {
  const sandboxRepository = {
    update: jest.fn(async (_id: string, input: { updateData: Partial<Sandbox>; entity: Sandbox }) => {
      Object.assign(input.entity, input.updateData)
      return input.entity
    }),
  }
  const runnerAdapter = {
    sandboxInfo: params?.sandboxInfoError
      ? jest.fn().mockRejectedValue(params.sandboxInfoError)
      : jest.fn().mockResolvedValue({ state: SandboxState.DESTROYED }),
    destroySandbox: jest.fn(),
  }
  const eventEmitter = { emit: jest.fn() }
  const action = new SandboxArchiveAction(
    { findOneOrFail: jest.fn().mockResolvedValue({ id: ownerId }) } as never,
    { create: jest.fn().mockResolvedValue(runnerAdapter) } as never,
    sandboxRepository as never,
    {
      lock: jest.fn().mockResolvedValue(true),
      unlock: jest.fn().mockResolvedValue(undefined),
      getCode: jest.fn().mockResolvedValue(lockCode),
    } as never,
    { get: jest.fn(), setex: jest.fn(), del: jest.fn() } as never,
    eventEmitter as unknown as EventEmitter2,
  )
  return { action, eventEmitter, sandboxRepository }
}

describe('SandboxArchiveAction local owner pinning', () => {
  it('archives local storage without a COS backup and preserves runnerId', async () => {
    const sandbox = archivedCandidate(SandboxStorageBackend.LOCAL, BackupState.NONE)
    const harness = createAction()

    await expect(harness.action.run(sandbox, lockCode as never)).resolves.toBe(DONT_SYNC_AGAIN)

    expect(sandbox).toMatchObject({
      state: SandboxState.ARCHIVED,
      runnerId: ownerId,
      backupState: BackupState.NONE,
    })
    expect(harness.sandboxRepository.update).toHaveBeenCalledWith(
      sandboxId,
      expect.objectContaining({
        updateData: expect.not.objectContaining({ runnerId: expect.anything() }),
      }),
    )
    expect(harness.eventEmitter.emit).not.toHaveBeenCalled()
  })

  it('does not enter the COS backup retry path for local storage', async () => {
    const sandbox = archivedCandidate(SandboxStorageBackend.LOCAL, BackupState.ERROR)
    const harness = createAction()

    await expect(harness.action.run(sandbox, lockCode as never)).resolves.toBe(DONT_SYNC_AGAIN)

    expect(sandbox).toMatchObject({
      state: SandboxState.ARCHIVED,
      runnerId: ownerId,
      backupState: BackupState.NONE,
    })
    expect(harness.eventEmitter.emit).not.toHaveBeenCalled()
  })

  it('keeps the legacy COS archive behavior that clears runnerId', async () => {
    const sandbox = archivedCandidate(SandboxStorageBackend.COS, BackupState.COMPLETED)
    const harness = createAction()

    await expect(harness.action.run(sandbox, lockCode as never)).resolves.toBe(DONT_SYNC_AGAIN)

    expect(sandbox).toMatchObject({ state: SandboxState.ARCHIVED, runnerId: null })
  })

  it('preserves the local owner when the owner Runner reports the container missing', async () => {
    const sandbox = archivedCandidate(SandboxStorageBackend.LOCAL, BackupState.NONE)
    const harness = createAction({ sandboxInfoError: { statusCode: 404 } })

    await expect(harness.action.run(sandbox, lockCode as never)).resolves.toBe(DONT_SYNC_AGAIN)

    expect(sandbox).toMatchObject({
      state: SandboxState.ARCHIVED,
      runnerId: ownerId,
      backupState: BackupState.NONE,
    })
  })
})
