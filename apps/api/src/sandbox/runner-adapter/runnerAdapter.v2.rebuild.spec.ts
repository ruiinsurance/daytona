import { RunnerAdapterV2 } from './runnerAdapter.v2'
import { Job } from '../entities/job.entity'
import { JobType } from '../enums/job-type.enum'
import { JobStatus } from '../enums/job-status.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { SandboxState } from '../enums/sandbox-state.enum'

describe('V2 rebuild job identity', () => {
  function fixture() {
    const repository = { withRebuildDispatch: jest.fn(async (_id, _owner, action) => action({ transaction: 'test' })) }
    const jobs = { findOne: jest.fn() }
    const service = { createJob: jest.fn(async () => ({ id: 'exact-job' })) }
    const adapter = new RunnerAdapterV2(repository as never, jobs as never, service as never)
    void adapter.init({ id: 'owner' } as never)
    const guard = jest.fn(async () => {})
    adapter.setRebuildOperation('operation', guard)
    return { repository, jobs, service, adapter, guard }
  }

  it('uses exact job ID and operation rather than an unrelated latest completed job', async () => {
    const f = fixture()
    await f.adapter.destroySandbox('same-id')
    f.jobs.findOne.mockResolvedValue(new Job({ id: 'exact-job', type: JobType.DESTROY_SANDBOX,
      status: JobStatus.COMPLETED, runnerId: 'owner', resourceId: 'same-id', resourceType: ResourceType.SANDBOX,
      payload: JSON.stringify({ kortixRebuildOperationId: 'operation' }) }))
    expect((await f.adapter.sandboxInfo('same-id')).state).toBe(SandboxState.DESTROYED)
    expect(f.jobs.findOne).toHaveBeenCalledWith({ where: {
      id: 'exact-job', runnerId: 'owner', resourceId: 'same-id', resourceType: ResourceType.SANDBOX,
    } })
    expect(f.service.createJob).toHaveBeenCalledWith(expect.anything(), JobType.DESTROY_SANDBOX,
      'owner', ResourceType.SANDBOX, 'same-id', { kortixRebuildOperationId: 'operation' })
  })

  it('ownership rotation before admission queues zero destructive jobs', async () => {
    const f = fixture()
    f.guard.mockRejectedValue(new Error('fenced') as never)
    await expect(f.adapter.destroySandbox('same-id')).rejects.toThrow('fenced')
    expect(f.service.createJob).not.toHaveBeenCalled()
  })

  it('does not accept a foreign-operation callback as its completion', async () => {
    const f = fixture()
    await f.adapter.destroySandbox('same-id')
    f.jobs.findOne.mockResolvedValue(new Job({ id: 'exact-job', type: JobType.DESTROY_SANDBOX,
      status: JobStatus.COMPLETED, runnerId: 'owner', resourceId: 'same-id', resourceType: ResourceType.SANDBOX,
      payload: JSON.stringify({ kortixRebuildOperationId: 'previous-operation' }) }))
    await expect(f.adapter.sandboxInfo('same-id')).rejects.toThrow('identity changed')
    expect(f.service.createJob).toHaveBeenCalledTimes(1)
  })
})
