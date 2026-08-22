/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RunnerState } from '../enums/runner-state.enum'
import { SandboxStorageBackend } from '../enums/sandbox-storage-backend.enum'
import { OwnerRunnerUnavailableError } from '../errors/owner-runner-unavailable.error'

export interface LocalVolumeMount {
  volumeId: string
  mountPath: string
  subpath?: string
  backend?: SandboxStorageBackend
}

export interface LocalVolumeSandbox {
  id: string
  runnerId?: string | null
  storageBackend: SandboxStorageBackend
  volumes: LocalVolumeMount[]
}

export interface LocalOwnerRunner {
  id: string
  state: RunnerState
  unschedulable: boolean
  draining: boolean
  localVolumeEnabled: boolean
}

export interface RunnerServiceHealthCapability {
  serviceName: string
  healthy: boolean
}

export function isLocalVolumeSandbox(sandbox: Pick<LocalVolumeSandbox, 'storageBackend'>): boolean {
  return sandbox.storageBackend === SandboxStorageBackend.LOCAL
}

export function allowsAutomaticOwnerChange(sandbox: Pick<LocalVolumeSandbox, 'storageBackend'>): boolean {
  return !isLocalVolumeSandbox(sandbox)
}

export function allowsBackupLifecycle(sandbox: Pick<LocalVolumeSandbox, 'storageBackend'>): boolean {
  return !isLocalVolumeSandbox(sandbox)
}

export function reportsLocalVolumeCapability(serviceHealth?: RunnerServiceHealthCapability[]): boolean {
  return serviceHealth?.some((service) => service.serviceName === 'local-volume' && service.healthy) ?? false
}

export function buildRunnerVolumes(sandbox: LocalVolumeSandbox): LocalVolumeMount[] {
  if (!isLocalVolumeSandbox(sandbox)) {
    return sandbox.volumes.map((volume) => ({ ...volume }))
  }

  const canonicalSubpath = `sandboxes/${sandbox.id}/workspace`
  const workspaceVolumes = sandbox.volumes.filter((volume) => volume.mountPath === '/workspace')
  const configVolumes = sandbox.volumes.filter((volume) => volume.mountPath === '/config')
  const workspace = workspaceVolumes[0]
  const config = configVolumes[0]

  if (workspaceVolumes.length !== 1 || !workspace || workspace.subpath !== canonicalSubpath) {
    throw new Error('local volume sandbox requires its canonical workspace subpath')
  }
  if (configVolumes.length > 1) {
    throw new Error('local volume sandbox has duplicate /config mounts')
  }
  if (config && (config.volumeId !== workspace.volumeId || config.subpath !== workspace.subpath)) {
    throw new Error('local volume sandbox requires matching /workspace and /config identity')
  }

  const nonWorkspaceVolumes = sandbox.volumes.filter(
    (volume) => volume.mountPath !== '/workspace' && volume.mountPath !== '/config',
  )
  if (nonWorkspaceVolumes.length > 0) {
    throw new Error('local volume sandbox cannot mix local and COS volume mounts')
  }
  const localIdentity = {
    volumeId: workspace.volumeId,
    subpath: workspace.subpath,
    backend: SandboxStorageBackend.LOCAL,
  }

  return [
    { ...localIdentity, mountPath: '/workspace' },
    { ...localIdentity, mountPath: '/config' },
  ]
}

export function assertLocalOwnerAvailable(
  sandbox: Pick<LocalVolumeSandbox, 'runnerId'>,
  runner: LocalOwnerRunner | null,
): string {
  if (
    !sandbox.runnerId ||
    !runner ||
    runner.id !== sandbox.runnerId ||
    runner.state !== RunnerState.READY ||
    runner.unschedulable ||
    runner.draining ||
    !runner.localVolumeEnabled
  ) {
    throw new OwnerRunnerUnavailableError(sandbox.runnerId ?? undefined)
  }
  return runner.id
}

export function shouldClearRunnerOnTerminalState(
  storageBackend: SandboxStorageBackend,
  state: 'archived' | 'destroyed',
): boolean {
  return state === 'destroyed' || storageBackend !== SandboxStorageBackend.LOCAL
}
