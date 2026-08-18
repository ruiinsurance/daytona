import { describe, expect, it, vi } from 'vitest'

vi.mock('../entities/job.entity', () => ({ Job: class Job {} }))
vi.mock('../entities/runner.entity', () => ({ Runner: class Runner {} }))
vi.mock('../entities/sandbox.entity', () => ({
  Sandbox: class Sandbox {
    static getBackupStateUpdate() {
      return {}
    }
  },
}))
vi.mock('../entities/snapshot-runner.entity', () => ({ SnapshotRunner: class SnapshotRunner {} }))
vi.mock('../entities/snapshot.entity', () => ({ Snapshot: class Snapshot {} }))

import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { SandboxState } from '../enums/sandbox-state.enum'
import { JobStateHandlerService } from './job-state-handler.service'

const SANDBOX_ID = '11111111-1111-4111-8111-111111111111'

function makeService() {
  const sandbox = {
    id: SANDBOX_ID,
    state: SandboxState.STOPPED,
  }
  const sandboxRepository = {
    findOne: vi.fn().mockResolvedValue(sandbox),
    update: vi.fn(),
  }
  const service = new JobStateHandlerService(
    sandboxRepository as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  )
  return { service, sandbox, sandboxRepository }
}

describe('JobStateHandlerService', () => {
  it.each([JobStatus.COMPLETED, JobStatus.FAILED])(
    'does not mutate the source sandbox for a move target preparation CREATE job (%s)',
    async (status) => {
      const { service, sandbox, sandboxRepository } = makeService()
      const job = {
        status,
        resourceId: SANDBOX_ID,
        type: JobType.CREATE_SANDBOX,
        getPayload: vi.fn().mockReturnValue({ moveTargetPreparation: true }),
      }

      await service.handleJobCompletion(job as any)

      expect(sandbox).toEqual({ id: SANDBOX_ID, state: SandboxState.STOPPED })
      expect(sandboxRepository.findOne).not.toHaveBeenCalled()
      expect(sandboxRepository.update).not.toHaveBeenCalled()
    },
  )
})
