/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import 'reflect-metadata'
import { Sandbox } from '../entities/sandbox.entity'
import { SandboxStorageBackend } from '../enums/sandbox-storage-backend.enum'
import { RunnerAdapterV0 } from './runnerAdapter.v0'

const sandboxId = '11111111-1111-4111-8111-111111111111'
const volumeId = '22222222-2222-4222-8222-222222222222'

describe('RunnerAdapterV0 local volume recovery', () => {
  it('preserves backend and expands the same source to workspace and config', async () => {
    const recover = jest.fn().mockResolvedValue(undefined)
    const adapter = new RunnerAdapterV0()
    Object.assign(adapter, { sandboxApiClient: { recover } })
    const sandbox = {
      id: sandboxId,
      organizationId: '33333333-3333-4333-8333-333333333333',
      storageBackend: SandboxStorageBackend.LOCAL,
      volumes: [
        {
          volumeId,
          mountPath: '/workspace',
          subpath: `sandboxes/${sandboxId}/workspace`,
        },
      ],
      env: {},
    } as Sandbox

    await adapter.recoverSandbox(sandbox)

    expect(recover).toHaveBeenCalledWith(
      sandboxId,
      expect.objectContaining({
        volumes: [
          {
            volumeId,
            mountPath: '/workspace',
            subpath: `sandboxes/${sandboxId}/workspace`,
            backend: SandboxStorageBackend.LOCAL,
          },
          {
            volumeId,
            mountPath: '/config',
            subpath: `sandboxes/${sandboxId}/workspace`,
            backend: SandboxStorageBackend.LOCAL,
          },
        ],
      }),
    )
  })
})
