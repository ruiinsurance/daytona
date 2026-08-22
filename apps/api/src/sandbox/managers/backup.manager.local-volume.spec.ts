/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import 'reflect-metadata'
import { Sandbox } from '../entities/sandbox.entity'
import { BackupState } from '../enums/backup-state.enum'
import { SandboxDesiredState } from '../enums/sandbox-desired-state.enum'
import { SandboxState } from '../enums/sandbox-state.enum'
import { SandboxStorageBackend } from '../enums/sandbox-storage-backend.enum'
import { SandboxArchivedEvent } from '../events/sandbox-archived.event'
import { BackupManager } from './backup.manager'

const sandboxId = '11111111-1111-4111-8111-111111111111'

function localSandbox(): Sandbox {
  return {
    id: sandboxId,
    runnerId: '22222222-2222-4222-8222-222222222222',
    storageBackend: SandboxStorageBackend.LOCAL,
    state: SandboxState.STOPPED,
    desiredState: SandboxDesiredState.ARCHIVED,
    backupState: BackupState.NONE,
  } as Sandbox
}

function createManager() {
  const dockerRegistryService = {
    findOne: jest.fn(),
    getAvailableBackupRegistry: jest.fn(),
  }
  const sandboxService = { updateSandboxBackupState: jest.fn() }
  const manager = new BackupManager(
    {} as never,
    sandboxService as never,
    {} as never,
    {} as never,
    dockerRegistryService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
  return { dockerRegistryService, manager, sandboxService }
}

describe('BackupManager local volume exclusions', () => {
  it('rejects local backup state transitions before registry or Runner I/O', async () => {
    const harness = createManager()

    await expect(harness.manager.setBackupPending(localSandbox())).rejects.toThrow(
      'Local volume sandbox backups are not supported in V1',
    )

    expect(harness.dockerRegistryService.findOne).not.toHaveBeenCalled()
    expect(harness.dockerRegistryService.getAvailableBackupRegistry).not.toHaveBeenCalled()
    expect(harness.sandboxService.updateSandboxBackupState).not.toHaveBeenCalled()
  })

  it('does not start a backup when a local sandbox enters the archive lifecycle', async () => {
    const harness = createManager()
    const setBackupPending = jest.spyOn(harness.manager, 'setBackupPending')
    const eventHandler = harness.manager as unknown as {
      handleSandboxArchivedEvent: (event: SandboxArchivedEvent) => Promise<void>
    }

    await eventHandler.handleSandboxArchivedEvent(new SandboxArchivedEvent(localSandbox()))

    expect(setBackupPending).not.toHaveBeenCalled()
  })
})
