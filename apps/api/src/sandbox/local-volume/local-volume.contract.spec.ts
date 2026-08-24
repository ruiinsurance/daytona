/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import 'reflect-metadata'
import { Sandbox } from '../entities/sandbox.entity'
import { RunnerState } from '../enums/runner-state.enum'
import { SandboxStorageBackend } from '../enums/sandbox-storage-backend.enum'
import { OwnerRunnerUnavailableError } from '../errors/owner-runner-unavailable.error'
import {
  assertLocalOwnerAvailable,
  allowsAutomaticOwnerChange,
  allowsBackupLifecycle,
  buildRunnerVolumes,
  matchesLocalVolumeRequirement,
  reportsLocalVolumeCapability,
  shouldClearRunnerOnTerminalState,
  type LocalOwnerRunner,
  type LocalVolumeSandbox,
} from './local-volume.contract'

const sandboxId = '11111111-1111-4111-8111-111111111111'
const runnerId = '22222222-2222-4222-8222-222222222222'
const volumeId = '33333333-3333-4333-8333-333333333333'
const workspaceSubpath = `sandboxes/${sandboxId}/workspace`

function localSandbox(): LocalVolumeSandbox {
  return {
    id: sandboxId,
    storageBackend: SandboxStorageBackend.LOCAL,
    runnerId,
    volumes: [{ volumeId, mountPath: '/workspace', subpath: workspaceSubpath }],
  }
}

function readyOwner(): LocalOwnerRunner {
  return {
    id: runnerId,
    state: RunnerState.READY,
    unschedulable: false,
    draining: false,
    localVolumeEnabled: true,
    serviceHealth: [{ serviceName: 'local-volume', healthy: true }],
  }
}

describe('local volume contract', () => {
  it('defaults new sandbox entities to local storage', () => {
    expect(new Sandbox({ id: sandboxId, region: 'local' }).storageBackend).toBe(SandboxStorageBackend.LOCAL)
  })

  it('builds explicit same-source workspace and config mounts', () => {
    expect(buildRunnerVolumes(localSandbox())).toEqual([
      {
        volumeId,
        mountPath: '/workspace',
        subpath: workspaceSubpath,
        backend: SandboxStorageBackend.LOCAL,
      },
      {
        volumeId,
        mountPath: '/config',
        subpath: workspaceSubpath,
        backend: SandboxStorageBackend.LOCAL,
      },
    ])
  })

  it('rejects a conflicting config source', () => {
    const sandbox = localSandbox()
    sandbox.volumes.push({
      volumeId: '44444444-4444-4444-8444-444444444444',
      mountPath: '/config',
      subpath: workspaceSubpath,
    })

    expect(() => buildRunnerVolumes(sandbox)).toThrow('matching /workspace and /config identity')
  })

  it('rejects duplicate workspace and config targets instead of normalizing them', () => {
    const duplicateWorkspace = localSandbox()
    duplicateWorkspace.volumes.push({ ...duplicateWorkspace.volumes[0] })
    expect(() => buildRunnerVolumes(duplicateWorkspace)).toThrow('canonical workspace subpath')

    const duplicateConfig = localSandbox()
    duplicateConfig.volumes.push(
      { volumeId, mountPath: '/config', subpath: workspaceSubpath },
      { volumeId, mountPath: '/config', subpath: workspaceSubpath },
    )
    expect(() => buildRunnerVolumes(duplicateConfig)).toThrow('duplicate /config mounts')
  })

  it('rejects a workspace subpath that is not the sandbox canonical path', () => {
    const sandbox = localSandbox()
    sandbox.volumes[0].subpath = 'sandboxes/another/workspace'

    expect(() => buildRunnerVolumes(sandbox)).toThrow('canonical workspace subpath')
  })

  it('rejects mixed local and COS mounts', () => {
    const sandbox = localSandbox()
    sandbox.volumes.push({
      volumeId: '44444444-4444-4444-8444-444444444444',
      mountPath: '/data',
    })

    expect(() => buildRunnerVolumes(sandbox)).toThrow('cannot mix local and COS volume mounts')
  })

  it('accepts only the persisted owner while it is available', () => {
    expect(assertLocalOwnerAvailable(localSandbox(), readyOwner())).toBe(runnerId)
  })

  it('keeps a local owner on archive while preserving COS cleanup', () => {
    expect(shouldClearRunnerOnTerminalState(SandboxStorageBackend.LOCAL, 'archived')).toBe(false)
    expect(shouldClearRunnerOnTerminalState(SandboxStorageBackend.COS, 'archived')).toBe(true)
    expect(shouldClearRunnerOnTerminalState(SandboxStorageBackend.LOCAL, 'destroyed')).toBe(true)
  })

  it('allows automatic fallback only for legacy COS sandboxes', () => {
    expect(allowsAutomaticOwnerChange(localSandbox())).toBe(false)
    expect(
      allowsAutomaticOwnerChange({
        ...localSandbox(),
        storageBackend: SandboxStorageBackend.COS,
      }),
    ).toBe(true)
  })

  it('allows the backup lifecycle only for legacy COS sandboxes', () => {
    expect(allowsBackupLifecycle(localSandbox())).toBe(false)
    expect(
      allowsBackupLifecycle({
        ...localSandbox(),
        storageBackend: SandboxStorageBackend.COS,
      }),
    ).toBe(true)
  })

  it('derives local capability only from a healthy Runner service report', () => {
    expect(reportsLocalVolumeCapability()).toBe(false)
    expect(reportsLocalVolumeCapability([{ serviceName: 'docker', healthy: true }])).toBe(false)
    expect(reportsLocalVolumeCapability([{ serviceName: 'local-volume', healthy: false }])).toBe(false)
    expect(reportsLocalVolumeCapability([{ serviceName: 'local-volume', healthy: true }])).toBe(true)
  })

  it('ignores the legacy local-volume boolean when current health proves the local root', () => {
    expect(
      assertLocalOwnerAvailable(localSandbox(), {
        ...readyOwner(),
        localVolumeEnabled: false,
      }),
    ).toBe(runnerId)
  })

  it('matches scheduling requirements from current health instead of the legacy boolean', () => {
    expect(
      matchesLocalVolumeRequirement(
        {
          localVolumeEnabled: false,
          serviceHealth: [{ serviceName: 'local-volume', healthy: true }],
        },
        true,
      ),
    ).toBe(true)
    expect(
      matchesLocalVolumeRequirement(
        {
          localVolumeEnabled: true,
          serviceHealth: [{ serviceName: 'local-volume', healthy: false }],
        },
        true,
      ),
    ).toBe(false)
    expect(matchesLocalVolumeRequirement({ localVolumeEnabled: false }, undefined)).toBe(true)
  })

  it.each([
    ['missing', null],
    ['wrong identity', { ...readyOwner(), id: '55555555-5555-4555-8555-555555555555' }],
    ['offline', { ...readyOwner(), state: RunnerState.UNRESPONSIVE }],
    ['unschedulable', { ...readyOwner(), unschedulable: true }],
    ['draining', { ...readyOwner(), draining: true }],
    ['without local health report', { ...readyOwner(), serviceHealth: undefined }],
    [
      'with unhealthy local root',
      { ...readyOwner(), serviceHealth: [{ serviceName: 'local-volume', healthy: false }] },
    ],
  ])('fails closed when the owner is %s', (_name, runner) => {
    expect(() => assertLocalOwnerAvailable(localSandbox(), runner as LocalOwnerRunner | null)).toThrow(
      OwnerRunnerUnavailableError,
    )
    try {
      assertLocalOwnerAvailable(localSandbox(), runner as LocalOwnerRunner | null)
    } catch (error) {
      expect((error as OwnerRunnerUnavailableError).getResponse()).toMatchObject({
        statusCode: 503,
        code: 'owner_runner_unavailable',
        ownerRunnerId: runnerId,
      })
    }
  })
})
