import { JobStateHandlerService } from './job-state-handler.service'
import { Job } from '../entities/job.entity'
import { JobType } from '../enums/job-type.enum'
import { JobStatus } from '../enums/job-status.enum'
import { ResourceType } from '../enums/resource-type.enum'

describe('rebuild job callbacks are observations, not lifecycle intent', () => {
  it('late and interleaved internal destroy/create/start callbacks perform zero entity writes or events', async () => {
    const repository = { findOne: jest.fn(), update: jest.fn(), updateWhere: jest.fn() }
    const events = { emit: jest.fn() }
    const handler = new JobStateHandlerService(repository as never, {} as never, {} as never, {} as never, events as never, {} as never)
    // Includes an old destroy callback after a replacement start has completed.
    for (const type of [JobType.CREATE_SANDBOX, JobType.DESTROY_SANDBOX, JobType.START_SANDBOX, JobType.DESTROY_SANDBOX]) {
      await handler.handleJobCompletion(new Job({
        type, status: JobStatus.COMPLETED, runnerId: 'old-owner',
        resourceType: ResourceType.SANDBOX, resourceId: 'same-sandbox',
        payload: JSON.stringify({ kortixRebuildOperationId: 'old-operation' }),
      }))
    }
    expect(repository.findOne).not.toHaveBeenCalled()
    expect(repository.update).not.toHaveBeenCalled()
    expect(repository.updateWhere).not.toHaveBeenCalled()
    expect(events.emit).not.toHaveBeenCalled()
  })
})
