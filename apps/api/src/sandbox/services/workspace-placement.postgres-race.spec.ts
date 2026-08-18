import { DataSource, Repository } from 'typeorm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WorkspaceOperation } from '../entities/workspace-operation.entity'
import { WorkspacePlacement } from '../entities/workspace-placement.entity'
import { WorkspacePlacementService } from './workspace-placement.service'

const RUNNER_A = '11111111-1111-4111-8111-111111111111'
const RUNNER_B = '22222222-2222-4222-8222-222222222222'
const SANDBOX_ID = '33333333-3333-4333-8333-333333333333'
const PLACEMENT_ID = '44444444-4444-4444-8444-444444444444'
const OPERATION_ID = '55555555-5555-4555-8555-555555555555'
const NOW = new Date('2026-08-19T00:00:00.000Z')

function isLoopbackDatabaseUrl(value: string | undefined): value is string {
  if (!value) return false
  try {
    const url = new URL(value)
    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
    )
  } catch {
    return false
  }
}

const databaseUrl = process.env.DAYTONA_TEST_DATABASE_URL
const databaseSuite = isLoopbackDatabaseUrl(databaseUrl) ? describe : describe.skip

databaseSuite('WorkspacePlacementService PostgreSQL race', () => {
  let dataSource: DataSource
  let placementRepository: Repository<WorkspacePlacement>
  let operationRepository: Repository<WorkspaceOperation>
  let service: WorkspacePlacementService

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: databaseUrl,
      entities: [WorkspacePlacement, WorkspaceOperation],
      synchronize: true,
      dropSchema: true,
      logging: false,
    })
    await dataSource.initialize()
    placementRepository = dataSource.getRepository(WorkspacePlacement)
    operationRepository = dataSource.getRepository(WorkspaceOperation)
    service = new WorkspacePlacementService(placementRepository, {} as any)

    await placementRepository.save({
      id: PLACEMENT_ID,
      volumeId: 'vol-1',
      subpath: `sandboxes/${SANDBOX_ID}/workspace`,
      sandboxId: SANDBOX_ID,
      ownerNodeId: RUNNER_A,
      localGeneration: '3',
      cosGeneration: '2',
      fenceEpoch: '3',
      leaseOwner: null,
      leaseExpiresAt: null,
      replicationStatus: 'pending',
      dirty: true,
    })
    await operationRepository.save({
      id: OPERATION_ID,
      type: 'move',
      phase: 'target_verified',
      placementId: PLACEMENT_ID,
      volumeId: 'vol-1',
      sandboxId: SANDBOX_ID,
      sourceNodeId: RUNNER_A,
      targetNodeId: RUNNER_B,
      idempotencyKey: 'move-idempotency-key',
      leaseOwner: 'move-worker:test',
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      expectedFenceEpoch: '3',
      checkpointGeneration: '4',
      targetGeneration: '4',
      targetManifestHash: 'a'.repeat(64),
      switchedFenceEpoch: null,
      errorCode: null,
      sourceRetained: false,
      completedAt: null,
    })
  })

  afterAll(async () => {
    await dataSource?.destroy()
  })

  it('allows one real PostgreSQL writer lease and rejects the concurrent loser', async () => {
    const results = await Promise.allSettled([
      service.acquireWriterLease({
        placementId: PLACEMENT_ID,
        nodeId: RUNNER_A,
        fenceEpoch: 3,
        leaseOwner: 'runner-a-process',
        now: NOW,
      }),
      service.acquireWriterLease({
        placementId: PLACEMENT_ID,
        nodeId: RUNNER_A,
        fenceEpoch: 3,
        leaseOwner: 'runner-b-process',
        now: NOW,
      }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(
      results.some((result) => result.status === 'rejected' && result.reason?.message === 'workspace_lease_conflict'),
    ).toBe(true)
    const placement = await placementRepository.findOneByOrFail({ id: PLACEMENT_ID })
    expect(placement.leaseOwner).toMatch(/^runner-[ab]-process$/)
  })

  it('allows one real PostgreSQL owner CAS and increments the fence once', async () => {
    await placementRepository.update(
      { id: PLACEMENT_ID },
      { ownerNodeId: RUNNER_A, fenceEpoch: '3', localGeneration: '3', leaseOwner: null, leaseExpiresAt: null },
    )

    const input = {
      placementId: PLACEMENT_ID,
      expectedOwnerNodeId: RUNNER_A,
      expectedFenceEpoch: 3,
      expectedLocalGeneration: '3',
      operationId: OPERATION_ID,
      operationLeaseOwner: 'move-worker:test',
      targetNodeId: RUNNER_B,
      targetGeneration: '4',
      targetVerified: true,
      now: NOW,
    }
    const results = await Promise.allSettled([service.switchOwner(input), service.switchOwner(input)])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(
      results.some((result) => result.status === 'rejected' && result.reason?.message === 'workspace_owner_cas_miss'),
    ).toBe(true)
    const placement = await placementRepository.findOneByOrFail({ id: PLACEMENT_ID })
    expect(placement).toMatchObject({ ownerNodeId: RUNNER_B, fenceEpoch: '4', localGeneration: '4' })
  })
})
