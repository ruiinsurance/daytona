import 'reflect-metadata'
import { Equal, In, IsNull, MoreThanOrEqual, Not, Or } from 'typeorm'
import { SnapshotManager } from './snapshot.manager'
import { Snapshot } from '../entities/snapshot.entity'
import { Runner } from '../entities/runner.entity'
import { SnapshotRunner } from '../entities/snapshot-runner.entity'
import { SnapshotState } from '../enums/snapshot-state.enum'
import { SnapshotRunnerState } from '../enums/snapshot-runner-state.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { SandboxClass } from '../enums/sandbox-class.enum'
import { GpuType } from '../enums/gpu-type.enum'
import { SnapshotStateError } from '../errors/snapshot-state-error'

const snapshot = {
  id: 'snapshot',
  ref: 'registry/image@sha256:digest',
  organizationId: 'org',
  state: SnapshotState.ACTIVE,
  gpu: 0,
  gpuType: null,
  sandboxClass: SandboxClass.CONTAINER,
} as Snapshot

function createHarness(fullCoverage = true, runnerCount = 4) {
  const runners = Array.from({ length: runnerCount }, (_, index) => ({
    id: `runner-${index}`,
    region: 'shared',
  })) as Runner[]
  const replicas: SnapshotRunner[] = []
  const locks = new Set<string>()
  const redisLockProvider = {
    lock: jest.fn(async (key: string) => {
      if (locks.has(key)) return false
      locks.add(key)
      return true
    }),
    unlock: jest.fn(async (key: string) => locks.delete(key)),
    unlockOwned: jest.fn(async (key: string) => locks.delete(key)),
  }
  const query = {
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    andWhereExists: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    getQuery: jest.fn().mockReturnValue('SELECT 1'),
    getMany: jest.fn().mockResolvedValue([]),
    getRawMany: jest.fn().mockResolvedValue([]),
  }
  const snapshotRepository = {
    exists: jest.fn().mockResolvedValue(true),
    count: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(snapshot),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    remove: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(query),
  }
  const snapshotRunnerRepository = {
    find: jest.fn(async (options) => {
      const states = options.where.state.value
      const runnerIds = options.where.runnerId.value
      return replicas.filter(
        (replica) =>
          runnerIds.includes(replica.runnerId) &&
          (Array.isArray(states) ? states.includes(replica.state) : replica.state === options.where.state),
      )
    }),
    update: jest.fn(async (criteria, changes) => {
      let affected = 0
      for (const replica of replicas) {
        if (
          typeof criteria === 'string'
            ? replica.id === criteria
            : Object.entries(criteria).every(([key, value]) => replica[key] === value)
        ) {
          Object.assign(replica, changes)
          affected++
        }
      }
      return { affected }
    }),
    save: jest.fn(async (replica) => replica),
    delete: jest.fn(async (id) => {
      const index = replicas.findIndex((replica) => replica.id === id)
      if (index >= 0) replicas.splice(index, 1)
    }),
    createQueryBuilder: jest.fn().mockReturnValue(query),
  }
  const runnerRepository = { find: jest.fn(async () => runners) }
  const runnerService = {
    getSnapshotRunner: jest.fn(async (runnerId: string) => replicas.find((replica) => replica.runnerId === runnerId)),
    createSnapshotRunnerEntry: jest.fn(async (runnerId, snapshotRef, state) => {
      replicas.push({ id: runnerId, runnerId, snapshotRef, state, createdAt: new Date(), updatedAt: new Date() })
    }),
  }
  const adapter = {
    pullSnapshot: jest.fn().mockResolvedValue(undefined),
    getSnapshotInfo: jest.fn().mockResolvedValue({}),
    snapshotExists: jest.fn().mockResolvedValue(false),
    removeSnapshot: jest.fn().mockResolvedValue(undefined),
  }
  const registryService = { findInternalRegistryBySnapshotRef: jest.fn().mockResolvedValue({ id: 'registry' }) }
  const snapshotService = { getSnapshotRegions: jest.fn().mockResolvedValue([]) }
  const manager = new SnapshotManager(
    { get: jest.fn(), set: jest.fn() } as never,
    snapshotRepository as never,
    snapshotRunnerRepository as never,
    runnerRepository as never,
    {} as never,
    {} as never,
    runnerService as never,
    registryService as never,
    { create: jest.fn().mockResolvedValue(adapter) } as never,
    redisLockProvider as never,
    {} as never,
    snapshotService as never,
    { get: jest.fn().mockReturnValue(fullCoverage), getOrThrow: jest.fn().mockReturnValue(7) } as never,
  )
  function addReplica(runnerId: string, state: SnapshotRunnerState) {
    const replica = {
      id: runnerId,
      runnerId,
      snapshotRef: snapshot.ref,
      state,
      createdAt: new Date(Date.now() - 7200000),
      updatedAt: new Date(Date.now() - 7200000),
    } as SnapshotRunner
    replicas.push(replica)
    return replica
  }
  const propagate = (target = snapshot) => manager.propagateSnapshotToRunners(target, ['shared'], ['dedicated'])
  return {
    manager,
    runners,
    replicas,
    adapter,
    runnerService,
    snapshotRepository,
    snapshotRunnerRepository,
    runnerRepository,
    redisLockProvider,
    query,
    registryService,
    snapshotService,
    addReplica,
    propagate,
  }
}

describe('active snapshot coverage', () => {
  it.each([2, 4])('dispatches pulls to all %i eligible runners, then confirms readiness via polling', async (count) => {
    const harness = createHarness(true, count)
    await harness.propagate()
    expect(harness.adapter.pullSnapshot).toHaveBeenCalledTimes(count)
    expect(harness.replicas.every((replica) => replica.state === SnapshotRunnerState.PULLING_SNAPSHOT)).toBe(true)
    for (const replica of harness.replicas) {
      await harness.manager.handleSnapshotRunnerStatePullingSnapshot(replica, harness.runners[0])
    }
    expect(harness.replicas.every((replica) => replica.state === SnapshotRunnerState.READY)).toBe(true)
    await harness.propagate()
    expect(harness.adapter.pullSnapshot).toHaveBeenCalledTimes(count)
  })

  it('fills new and recovered/missing replicas on later reconciliation', async () => {
    const harness = createHarness()
    await harness.propagate()
    harness.runners.push({ id: 'new-runner', region: 'shared' } as Runner)
    harness.replicas.splice(0, 1)
    await harness.propagate()
    expect(harness.replicas).toHaveLength(5)
    expect(harness.adapter.pullSnapshot).toHaveBeenCalledTimes(6)
  })

  it('preserves query eligibility boundaries, including draining and GPU/class constraints', async () => {
    const harness = createHarness()
    await harness.propagate({ ...snapshot, gpu: 2, gpuType: GpuType.H100, sandboxClass: SandboxClass.ANDROID })
    expect(harness.runnerRepository.find).toHaveBeenCalledWith({
      where: {
        state: RunnerState.READY,
        unschedulable: Not(true),
        draining: Not(true),
        region: In(['shared', 'dedicated']),
        gpu: MoreThanOrEqual(2),
        gpuType: GpuType.H100,
        sandboxClass: SandboxClass.CONTAINER,
      },
    })
    await harness.propagate()
    expect(harness.runnerRepository.find).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        gpu: Or(IsNull(), Equal(0)),
        gpuType: IsNull(),
      }),
    })
  })

  it('reconciles only shared and owning-organization regions from the active snapshot cron', async () => {
    const harness = createHarness()
    harness.query.getMany.mockResolvedValue([snapshot])
    harness.snapshotService.getSnapshotRegions.mockResolvedValue([
      { id: 'shared', organizationId: null },
      { id: 'dedicated', organizationId: 'org' },
      { id: 'other-tenant', organizationId: 'other' },
    ])
    const propagate = jest.spyOn(harness.manager, 'propagateSnapshotToRunners').mockResolvedValue(undefined)
    await harness.manager.syncRunnerSnapshots()
    expect(propagate).toHaveBeenCalledWith(snapshot, ['shared'], ['dedicated'])
    expect(harness.query.where).toHaveBeenCalledWith('snapshot.state = :snapshotState', {
      snapshotState: SnapshotState.ACTIVE,
    })
    expect(harness.query.andWhere).toHaveBeenCalledWith('org.suspended = false')
  })

  it('retains legacy shared ratios and all dedicated runners when disabled', async () => {
    const harness = createHarness(false)
    harness.runners.push({ id: 'dedicated', region: 'dedicated' } as Runner)
    await harness.propagate()
    expect(harness.adapter.pullSnapshot).toHaveBeenCalledTimes(3)
    expect(harness.replicas.some((replica) => replica.runnerId === 'dedicated')).toBe(true)
  })

  it('preserves non-registry snapshot transport without requiring an OCI registry', async () => {
    const harness = createHarness(true, 1)
    await harness.propagate({ ...snapshot, sandboxClass: SandboxClass.WINDOWS })
    expect(harness.registryService.findInternalRegistryBySnapshotRef).not.toHaveBeenCalled()
    expect(harness.adapter.pullSnapshot).toHaveBeenCalledWith(
      snapshot.ref,
      undefined,
      undefined,
      undefined,
      undefined,
      SandboxClass.WINDOWS,
    )
  })

  it('defers registry snapshots when their region has no registry', async () => {
    const harness = createHarness()
    harness.registryService.findInternalRegistryBySnapshotRef.mockResolvedValue(undefined)
    await harness.propagate()
    expect(harness.adapter.pullSnapshot).not.toHaveBeenCalled()
    expect(harness.runnerService.createSnapshotRunnerEntry).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent reconciliations of aliases sharing a ref', async () => {
    const harness = createHarness()
    await Promise.all([harness.propagate(), harness.propagate({ ...snapshot, id: 'alias' })])
    expect(harness.adapter.pullSnapshot).toHaveBeenCalledTimes(4)
    expect(harness.replicas).toHaveLength(4)
  })

  it('waits for building, pending and removing states, then repulls after removal', async () => {
    const harness = createHarness()
    harness.addReplica('runner-0', SnapshotRunnerState.BUILDING_SNAPSHOT)
    harness.addReplica('runner-1', SnapshotRunnerState.PULLING_SNAPSHOT)
    const removing = harness.addReplica('runner-2', SnapshotRunnerState.REMOVING)
    harness.addReplica('runner-3', SnapshotRunnerState.READY)
    await harness.propagate()
    expect(harness.adapter.pullSnapshot).not.toHaveBeenCalled()
    await harness.manager.handleSnapshotRunnerStateRemoving(removing, harness.runners[2])
    await harness.propagate()
    expect(harness.adapter.pullSnapshot).toHaveBeenCalledTimes(1)
  })

  it('records enqueue failure and retries ERROR without inventing READY', async () => {
    const harness = createHarness(true, 1)
    harness.adapter.pullSnapshot.mockRejectedValueOnce(new Error('enqueue failed'))
    await harness.propagate()
    expect(harness.replicas[0].state).toBe(SnapshotRunnerState.ERROR)
    harness.replicas[0].updatedAt = new Date(Date.now() - 120000)
    await harness.propagate()
    expect(harness.adapter.pullSnapshot).toHaveBeenCalledTimes(2)
    expect(harness.replicas[0].state).toBe(SnapshotRunnerState.PULLING_SNAPSHOT)
  })

  it('does not overwrite a concurrent completion when enqueue reports an error', async () => {
    const harness = createHarness(true, 1)
    harness.adapter.pullSnapshot.mockImplementationOnce(async () => {
      harness.replicas[0].state = SnapshotRunnerState.READY
      throw new Error('response lost after completion')
    })
    await harness.propagate()
    expect(harness.replicas[0].state).toBe(SnapshotRunnerState.READY)
  })

  it('retries Runner-reported failure after cooldown', async () => {
    const harness = createHarness(true, 1)
    await harness.propagate()
    harness.adapter.getSnapshotInfo.mockRejectedValueOnce(new SnapshotStateError('pull failed'))
    await harness.manager.handleSnapshotRunnerStatePullingSnapshot(harness.replicas[0], harness.runners[0])
    expect(harness.replicas[0].state).toBe(SnapshotRunnerState.ERROR)
    harness.replicas[0].updatedAt = new Date()
    await harness.propagate()
    expect(harness.adapter.pullSnapshot).toHaveBeenCalledTimes(1)
    harness.replicas[0].updatedAt = new Date(Date.now() - 120000)
    await harness.propagate()
    expect(harness.adapter.pullSnapshot).toHaveBeenCalledTimes(2)
  })

  it('starts a fresh polling window when retrying an old ERROR replica', async () => {
    const harness = createHarness(true, 1)
    const replica = harness.addReplica('runner-0', SnapshotRunnerState.ERROR)
    await harness.propagate()
    expect(replica.state).toBe(SnapshotRunnerState.PULLING_SNAPSHOT)
    expect(replica.createdAt.getTime()).toBeGreaterThan(Date.now() - 60000)
    harness.adapter.getSnapshotInfo.mockRejectedValueOnce(new Error('still pulling'))
    await harness.manager.handleSnapshotRunnerStatePullingSnapshot(replica, harness.runners[0])
    expect(harness.adapter.pullSnapshot).toHaveBeenCalledTimes(1)
  })

  it('bounds each propagation pass and eventually covers larger fleets', async () => {
    const harness = createHarness(true, 24)
    await harness.propagate()
    expect(harness.adapter.pullSnapshot).toHaveBeenCalledTimes(10)
    await harness.propagate()
    await harness.propagate()
    expect(harness.adapter.pullSnapshot).toHaveBeenCalledTimes(24)
  })

  it('does not propagate a snapshot deactivated/deleted after selection', async () => {
    const harness = createHarness()
    harness.snapshotRepository.exists.mockResolvedValue(false)
    await harness.propagate()
    expect(harness.adapter.pullSnapshot).not.toHaveBeenCalled()
  })

  it('rechecks replica state under the lock instead of overwriting concurrent removal', async () => {
    const harness = createHarness(true, 1)
    harness.runnerService.getSnapshotRunner.mockImplementationOnce(async () =>
      harness.addReplica('runner-0', SnapshotRunnerState.REMOVING),
    )
    await harness.propagate()
    expect(harness.adapter.pullSnapshot).not.toHaveBeenCalled()
    expect(harness.replicas[0].state).toBe(SnapshotRunnerState.REMOVING)
  })

  it('does not pull if an ERROR retry loses its conditional state transition', async () => {
    const harness = createHarness(true, 1)
    harness.addReplica('runner-0', SnapshotRunnerState.ERROR)
    harness.snapshotRunnerRepository.update.mockResolvedValueOnce({ affected: 0 })
    await harness.propagate()
    expect(harness.adapter.pullSnapshot).not.toHaveBeenCalled()
  })

  it('does not scale down active replicas older than one hour in full mode', async () => {
    const harness = createHarness()
    harness.runners.forEach((runner) => harness.addReplica(runner.id, SnapshotRunnerState.READY))
    expect(await harness.manager.scaleDownSnapshotFromRunners(snapshot, ['shared'])).toBe(0)
    await harness.manager.scaleDownRunnerSnapshots()
    expect(harness.snapshotRunnerRepository.update).not.toHaveBeenCalled()
  })

  it('keeps legacy ratio scale-down when disabled', async () => {
    const harness = createHarness(false)
    harness.runners.forEach((runner) => harness.addReplica(runner.id, SnapshotRunnerState.READY))
    expect(await harness.manager.scaleDownSnapshotFromRunners(snapshot, ['shared'])).toBe(2)
  })

  it('still deactivates idle snapshots and schedules their replicas for removal', async () => {
    const harness = createHarness()
    harness.query.getMany.mockResolvedValue([snapshot])
    await harness.manager.deactivateOldSnapshots()
    expect(harness.snapshotRepository.update).toHaveBeenCalledWith(snapshot.id, {
      updateData: { state: SnapshotState.INACTIVE },
      entity: snapshot,
    })
    expect(harness.snapshotRunnerRepository.update).toHaveBeenCalledWith(
      { snapshotRef: In([snapshot.ref]) },
      { state: SnapshotRunnerState.REMOVING },
    )
  })

  it('does not evict a shared ref when another alias remains active during idle deactivation', async () => {
    const harness = createHarness()
    harness.query.getMany.mockResolvedValue([snapshot])
    harness.snapshotRepository.count.mockResolvedValue(1)
    await harness.manager.deactivateOldSnapshots()
    expect(harness.snapshotRunnerRepository.update).not.toHaveBeenCalled()
  })

  it('preserves replicas when one idle alias fails to deactivate', async () => {
    const harness = createHarness()
    harness.query.getMany.mockResolvedValue([snapshot, { ...snapshot, id: 'alias' }])
    harness.snapshotRepository.update.mockRejectedValueOnce(new Error('update failed'))
    harness.snapshotRepository.count.mockResolvedValue(1)
    await harness.manager.deactivateOldSnapshots()
    expect(harness.snapshotRepository.update).toHaveBeenCalledTimes(2)
    expect(harness.snapshotRunnerRepository.update).not.toHaveBeenCalled()
  })

  it('still cleans inactive refs, excluding refs with active aliases', async () => {
    const harness = createHarness()
    harness.query.getRawMany.mockResolvedValue([{ ref: snapshot.ref }])
    await harness.manager.cleanupInactiveSnapshotsFromRunners()
    expect(harness.query.andWhere).toHaveBeenCalledWith(expect.any(Function), { activeState: SnapshotState.ACTIVE })
    expect(harness.snapshotRunnerRepository.update).toHaveBeenCalledWith(
      { snapshotRef: In([snapshot.ref]) },
      { state: SnapshotRunnerState.REMOVING },
    )
  })

  it('protects active shared refs from BuildInfo age cleanup', async () => {
    const harness = createHarness()
    await harness.manager.cleanupOldBuildInfoSnapshotRunners()
    expect(harness.query.andWhere).toHaveBeenCalledWith(expect.stringContaining('NOT EXISTS'), {
      activeState: SnapshotState.ACTIVE,
    })
  })

  it.each([0, 1])('preserves explicit deletion and active alias protection (aliases=%i)', async (aliases) => {
    const harness = createHarness()
    harness.snapshotRepository.find.mockResolvedValue([{ ...snapshot, state: SnapshotState.REMOVING }])
    harness.snapshotRepository.count.mockResolvedValue(aliases)
    await harness.manager.checkSnapshotCleanup()
    expect(harness.snapshotRepository.remove).toHaveBeenCalled()
    expect(harness.snapshotRunnerRepository.update).toHaveBeenCalledTimes(aliases === 0 ? 1 : 0)
  })
})
