/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Sandbox } from '../entities/sandbox.entity'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { SandboxClass } from '../enums/sandbox-class.enum'
import { SandboxState } from '../enums/sandbox-state.enum'
import { SandboxStorageBackend } from '../enums/sandbox-storage-backend.enum'
import { RunnerAdapterV2 } from './runnerAdapter.v2'

const sandboxId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const runnerId = '33333333-3333-4333-8333-333333333333'
const volumeId = '44444444-4444-4444-8444-444444444444'
const subpath = `sandboxes/${sandboxId}/workspace`

function sandbox(): Sandbox {
  return {
    id: sandboxId,
    organizationId,
    runnerId,
    name: 'retained-workspace',
    storageBackend: SandboxStorageBackend.LOCAL,
    state: SandboxState.STOPPED,
    sandboxClass: SandboxClass.CONTAINER,
    osUser: 'daytona',
    env: {},
    cpu: 2,
    gpu: 0,
    mem: 4,
    disk: 20,
    region: 'local',
    volumes: [
      { volumeId, mountPath: '/workspace', subpath },
      { volumeId, mountPath: '/config', subpath },
    ],
  } as unknown as Sandbox
}

function adapterHarness() {
  const sandboxRepository = { findOne: jest.fn().mockResolvedValue(sandbox()) }
  const jobRepository = { findOne: jest.fn() }
  const jobService = { createJob: jest.fn().mockResolvedValue({ id: 'job-id' }) }
  const adapter = new RunnerAdapterV2(sandboxRepository as never, jobRepository as never, jobService as never)
  void adapter.init({ id: runnerId } as never)
  return { adapter, sandboxRepository, jobRepository, jobService }
}

describe('RunnerAdapterV2 missing-compute recovery', () => {
  it('puts the fail-closed retained-workspace requirement in the create Job payload', async () => {
    const { adapter, jobService } = adapterHarness()

    await adapter.createSandbox(
      sandbox(),
      'registry.example.com/runtime@sha256:abc',
      undefined,
      ['/usr/bin/start'],
      undefined,
      undefined,
      undefined,
      { requireExistingLocalWorkspace: true },
    )

    expect(jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.CREATE_SANDBOX,
      runnerId,
      ResourceType.SANDBOX,
      sandboxId,
      expect.objectContaining({
        requireExistingLocalWorkspace: true,
        volumes: [
          { volumeId, mountPath: '/workspace', subpath, backend: SandboxStorageBackend.LOCAL },
          { volumeId, mountPath: '/config', subpath, backend: SandboxStorageBackend.LOCAL },
        ],
      }),
    )
  })

  it('maps an exact missing-workspace create failure to a stable Runner error code', async () => {
    const { adapter, jobRepository } = adapterHarness()
    jobRepository.findOne.mockResolvedValueOnce({
      id: 'failed-create-job',
      type: JobType.CREATE_SANDBOX,
      status: JobStatus.FAILED,
      errorMessage: 'LOCAL_WORKSPACE_MISSING: required local workspace is missing',
      getResultMetadata: jest.fn().mockReturnValue(undefined),
    })

    await expect(adapter.sandboxInfo(sandboxId)).resolves.toEqual(
      expect.objectContaining({ state: SandboxState.ERROR, errorCode: 'LOCAL_WORKSPACE_MISSING' }),
    )
  })
})
