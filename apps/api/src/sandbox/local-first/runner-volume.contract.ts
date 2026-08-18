/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { Sandbox } from '../entities/sandbox.entity'

export interface LocalFirstWorkspacePreparation {
  volumeId: string
  nodeId: string
  fenceEpoch: string
  leaseOwner: string
  leaseExpiresAt: string
}

export function buildPreparedLocalFirstVolumes(
  sandbox: Pick<Sandbox, 'id' | 'volumes'>,
  preparation: LocalFirstWorkspacePreparation,
): Array<Record<string, string>> {
  const volumes =
    sandbox.volumes?.map((volume) => ({
      volumeId: volume.volumeId,
      mountPath: volume.mountPath,
      ...(volume.subpath ? { subpath: volume.subpath } : {}),
    })) ?? []
  const workspace = sandbox.volumes?.find((volume) => volume.mountPath === '/workspace')
  const config = sandbox.volumes?.find((volume) => volume.mountPath === '/config')
  if (
    !workspace ||
    !config ||
    workspace.volumeId !== config.volumeId ||
    workspace.subpath !== config.subpath ||
    workspace.volumeId !== preparation.volumeId ||
    workspace.subpath !== `sandboxes/${sandbox.id}/workspace`
  ) {
    throw new Error('local-first workspace requires matching /workspace and /config identity')
  }

  return volumes.map((volume) => {
    if (volume.mountPath !== '/workspace' && volume.mountPath !== '/config') return volume
    return {
      ...volume,
      backend: 'local-first',
      nodeId: preparation.nodeId,
      fenceEpoch: preparation.fenceEpoch,
      leaseOwner: preparation.leaseOwner,
      leaseExpiresAt: preparation.leaseExpiresAt,
    }
  })
}
