import { describe, expect, it, vi } from 'vitest'
import { WorkspaceGenerationService } from './workspace-generation.service'
import { WorkspacePlacementService } from './workspace-placement.service'
import { WorkspaceGenerationState } from '../enums/workspace-generation-state.enum'
import { checkpointContentHash, chooseRecoverySource, manifestHash } from '../local-first/workspace-generation.contract'

const PLACEMENT_ID = '11111111-1111-4111-8111-111111111111'
const VOLUME_ID = '22222222-2222-4222-8222-222222222222'
const SANDBOX_ID = '33333333-3333-4333-8333-333333333333'

function placement(overrides: Record<string, unknown> = {}) {
  return {
    id: PLACEMENT_ID,
    volumeId: VOLUME_ID,
    subpath: `sandboxes/${SANDBOX_ID}/workspace`,
    sandboxId: SANDBOX_ID,
    ownerNodeId: '44444444-4444-4444-8444-444444444444',
    localGeneration: '0',
    cosGeneration: '0',
    fenceEpoch: '1',
    leaseOwner: null,
    leaseExpiresAt: null,
    replicationStatus: 'pending',
    dirty: true,
    ...overrides,
  }
}

function setup() {
  const current = placement()
  const generationRows: any[] = []
  const placementRepository = {
    findOne: vi.fn().mockResolvedValue(current),
    save: vi.fn(async (value) => value),
  }
  const generationRepository = {
    findOne: vi.fn(
      async ({ where }: any) =>
        generationRows.find((row) => row.placementId === where.placementId && row.generation === where.generation) ??
        null,
    ),
    create: vi.fn((value) => ({ id: '55555555-5555-4555-8555-555555555555', ...value })),
    save: vi.fn(async (value) => {
      const index = generationRows.findIndex((row) => row.id === value.id)
      if (index === -1) generationRows.push(value)
      else generationRows[index] = value
      return value
    }),
  }
  const workspacePlacementService = {
    acquireWriterLease: vi.fn(async (input: { leaseOwner: string; now: Date }) => {
      current.leaseOwner = input.leaseOwner
      current.leaseExpiresAt = new Date(input.now.getTime() + 10 * 60 * 1000)
      return current
    }),
    releaseWriterLease: vi.fn(async () => {
      current.leaseOwner = null
      current.leaseExpiresAt = null
      return true
    }),
  }
  const service = new WorkspaceGenerationService(
    generationRepository as any,
    placementRepository as any,
    workspacePlacementService as any,
  )
  return { service, current, generationRows, placementRepository, generationRepository, workspacePlacementService }
}

function checkpoint() {
  const objects = [
    {
      key: 'state.db',
      body: 'state',
      size: 5,
      sha256: '4ba69735ca53765ed6a709edb56c6ea236b7193a3b29a6b390c346f0f4340e4e',
    },
  ]
  const manifest = {
    formatVersion: 1 as const,
    volumeId: VOLUME_ID,
    sandboxId: SANDBOX_ID,
    generation: '1',
    objectCount: 1,
    bytes: 5,
    contentHash: checkpointContentHash(objects),
    createdAt: '2026-08-17T00:00:00.000Z',
  }
  return {
    sourcePath: '/srv/kortix-storage/checkpoints/1',
    generation: '1',
    manifest,
    objects,
  }
}

describe('WorkspaceGenerationService', () => {
  it('marks a watcher event dirty without uploading or reading workspace data', async () => {
    const { service, current } = setup()
    await service.markDirty({ placementId: PLACEMENT_ID, localGeneration: '4' })
    expect(current.dirty).toBe(true)
    expect(current.localGeneration).toBe('4')
    expect(current.replicationStatus).toBe('pending')
  })

  it('rejects a watcher generation that would move local state backwards', async () => {
    const { service, current, placementRepository } = setup()
    current.localGeneration = '4'
    current.cosGeneration = '3'

    await expect(service.markDirty({ placementId: PLACEMENT_ID, localGeneration: '2' })).rejects.toThrow(
      'local_generation_regression',
    )

    expect(placementRepository.save).not.toHaveBeenCalled()
  })

  it('uploads immutable files, manifest, read-back, commit marker, then latest in order', async () => {
    const { service, current, generationRows, workspacePlacementService } = setup()
    const events: string[] = []
    const snapshot = checkpoint()
    const store = {
      putObjects: vi.fn(async () => events.push('objects')),
      putManifest: vi.fn(async () => events.push('manifest')),
      readManifest: vi.fn(async () => {
        events.push('readback')
        return snapshot.manifest
      }),
      putCommittedMarker: vi.fn(async () => events.push('committed')),
      getLatest: vi.fn(async () => {
        events.push('get-latest')
        return null
      }),
      compareAndSetLatest: vi.fn(async () => {
        events.push('latest')
        return true
      }),
    }
    const source = {
      create: vi.fn(async (input: { operationId?: string; nextGeneration: string }) => {
        const intent = generationRows.find((row) => row.generation === input.nextGeneration)
        expect(intent).toMatchObject({
          state: WorkspaceGenerationState.CHECKPOINTING,
          operationId: input.operationId,
        })
        return snapshot
      }),
    }

    const result = await service.reconcile({
      placementId: PLACEMENT_ID,
      source,
      store,
      now: new Date('2026-08-17T00:00:00.000Z'),
    })

    expect(result.outcome).toBe('committed')
    expect(events).toEqual(['objects', 'manifest', 'readback', 'committed', 'get-latest', 'latest'])
    expect(current.cosGeneration).toBe('1')
    expect(current.replicationStatus).toBe('durable')
    expect(current.dirty).toBe(false)
    expect(source.create).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        fenceEpoch: '1',
        leaseOwner: expect.stringMatching(new RegExp(`^generation-worker:[0-9a-f-]+:${PLACEMENT_ID}$`)),
        leaseExpiresAt: expect.any(String),
      }),
    )
    expect(source.create.mock.calls[0][0].operationId).not.toBe(PLACEMENT_ID)
    expect(workspacePlacementService.acquireWriterLease).toHaveBeenCalledWith(
      expect.objectContaining({
        placementId: PLACEMENT_ID,
        nodeId: '44444444-4444-4444-8444-444444444444',
        fenceEpoch: 1,
        leaseOwner: expect.stringMatching(new RegExp(`^generation-worker:[0-9a-f-]+:${PLACEMENT_ID}$`)),
      }),
    )
    expect(workspacePlacementService.releaseWriterLease).toHaveBeenCalledWith(
      expect.objectContaining({
        placementId: PLACEMENT_ID,
        fenceEpoch: 1,
        leaseOwner: expect.stringMatching(new RegExp(`^generation-worker:[0-9a-f-]+:${PLACEMENT_ID}$`)),
      }),
    )
    expect(generationRows[0]).toMatchObject({ state: WorkspaceGenerationState.COMMITTED, generation: '1' })
    expect(generationRows[0].manifestHash).toBe(manifestHash(snapshot.manifest))
  })

  it('does not regress placement generations when latest CAS loses to a newer worker', async () => {
    const { service, current } = setup()
    const snapshot = checkpoint()
    const store = {
      putObjects: vi.fn(),
      putManifest: vi.fn(),
      readManifest: vi.fn(async () => snapshot.manifest),
      putCommittedMarker: vi.fn(),
      getLatest: vi.fn(async () => {
        current.localGeneration = '8'
        current.cosGeneration = '7'
        return '3'
      }),
      compareAndSetLatest: vi.fn().mockResolvedValue(false),
    }

    await expect(
      service.reconcile({
        placementId: PLACEMENT_ID,
        source: { create: vi.fn(async () => snapshot) },
        store,
      }),
    ).resolves.toMatchObject({ outcome: 'committed' })

    expect(current).toMatchObject({
      localGeneration: '8',
      cosGeneration: '7',
      dirty: true,
      replicationStatus: 'committed',
    })
    expect(store.compareAndSetLatest).not.toHaveBeenCalled()
  })

  it('persists the authoritative writer lease with placement replication state', async () => {
    const { service, current, placementRepository, workspacePlacementService } = setup()
    const savedPlacements: any[] = []
    placementRepository.save.mockImplementation(async (value) => {
      savedPlacements.push(structuredClone(value))
      return value
    })
    const leaseExpiresAt = new Date('2026-08-17T00:10:00.000Z')
    workspacePlacementService.acquireWriterLease.mockImplementationOnce(async (input) => ({
      ...current,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt,
      fenceEpoch: '1',
    }))
    const snapshot = checkpoint()
    const store = {
      putObjects: vi.fn(),
      putManifest: vi.fn(),
      readManifest: vi.fn(async () => snapshot.manifest),
      putCommittedMarker: vi.fn(),
      getLatest: vi.fn(async () => null),
      compareAndSetLatest: vi.fn(async () => true),
    }

    await service.reconcile({
      placementId: PLACEMENT_ID,
      source: { create: vi.fn(async () => snapshot) },
      store,
      now: new Date('2026-08-17T00:00:00.000Z'),
    })

    const savedLeaseOwner = savedPlacements.at(-1)?.leaseOwner
    expect(savedLeaseOwner).toMatch(/^generation-worker:/)
    expect(savedPlacements.at(-1)).toMatchObject({ leaseExpiresAt })
    expect(workspacePlacementService.releaseWriterLease).toHaveBeenCalledWith(
      expect.objectContaining({ leaseOwner: savedLeaseOwner }),
    )
  })

  it('retains failed generations and never advances latest after partial upload', async () => {
    const { service, current, generationRows } = setup()
    const events: string[] = []
    const store = {
      putObjects: vi.fn(async () => events.push('objects')),
      putManifest: vi.fn(async () => {
        events.push('manifest')
        throw new Error('COS body omitted from assertion')
      }),
      readManifest: vi.fn(),
      putCommittedMarker: vi.fn(),
      getLatest: vi.fn(),
      compareAndSetLatest: vi.fn(),
    }
    await expect(
      service.reconcile({
        placementId: PLACEMENT_ID,
        source: { create: vi.fn(async () => checkpoint()) },
        store,
      }),
    ).rejects.toThrow('generation_upload_failed')

    expect(events).toEqual(['objects', 'manifest'])
    expect(store.putCommittedMarker).not.toHaveBeenCalled()
    expect(store.compareAndSetLatest).not.toHaveBeenCalled()
    expect(generationRows[0]).toMatchObject({
      state: WorkspaceGenerationState.FAILED,
      errorCode: 'generation_upload_failed',
    })
    expect(current.cosGeneration).toBe('0')
    expect(current.dirty).toBe(true)
  })

  it('reconciles an object-store outage after checkpointing without changing operation identity', async () => {
    const { service, current, generationRows, generationRepository, placementRepository, workspacePlacementService } =
      setup()
    const snapshot = checkpoint()
    let outage = true
    const source = { create: vi.fn(async () => snapshot) }
    const store = {
      putObjects: vi.fn(),
      putManifest: vi.fn(async () => {
        if (outage) {
          outage = false
          throw new Error('object_store_unavailable')
        }
      }),
      readManifest: vi.fn(async () => snapshot.manifest),
      putCommittedMarker: vi.fn(),
      getLatest: vi.fn(async () => null),
      compareAndSetLatest: vi.fn(async () => true),
    }

    await expect(
      service.reconcile({
        placementId: PLACEMENT_ID,
        source,
        store,
        now: new Date('2026-08-17T00:00:00.000Z'),
      }),
    ).rejects.toThrow('generation_upload_failed')

    const operationId = generationRows[0].operationId
    expect(generationRows[0]).toMatchObject({ state: WorkspaceGenerationState.FAILED, operationId })
    expect(current).toMatchObject({ cosGeneration: '0', dirty: true, replicationStatus: 'failed' })
    expect(store.putCommittedMarker).not.toHaveBeenCalled()
    expect(store.compareAndSetLatest).not.toHaveBeenCalled()

    const replacementService = new WorkspaceGenerationService(
      generationRepository as any,
      placementRepository as any,
      workspacePlacementService as any,
    )
    await expect(
      replacementService.reconcile({
        placementId: PLACEMENT_ID,
        source,
        store,
        now: new Date('2026-08-17T00:01:00.000Z'),
      }),
    ).resolves.toMatchObject({ outcome: 'committed' })

    expect(source.create).toHaveBeenLastCalledWith(expect.objectContaining({ operationId }))
    expect(store.putCommittedMarker).toHaveBeenCalledOnce()
    expect(store.compareAndSetLatest).toHaveBeenCalledOnce()
    expect(current).toMatchObject({ cosGeneration: '1', dirty: false, replicationStatus: 'durable' })
  })

  it('keeps owner-local start allowed when COS fails after a local checkpoint', async () => {
    const { service, current, generationRows, workspacePlacementService } = setup()
    current.localGeneration = '8'
    current.cosGeneration = '7'

    const checkpointed = checkpoint()
    checkpointed.generation = '9'
    checkpointed.manifest = { ...checkpointed.manifest, generation: '9' }
    const store = {
      putObjects: vi.fn(),
      putManifest: vi.fn(async () => {
        throw new Error('object_store_unavailable')
      }),
      readManifest: vi.fn(),
      putCommittedMarker: vi.fn(),
      getLatest: vi.fn(),
      compareAndSetLatest: vi.fn(),
    }

    await expect(
      service.reconcile({
        placementId: PLACEMENT_ID,
        source: { create: vi.fn(async () => checkpointed) },
        store,
        now: new Date('2026-08-17T00:00:00.000Z'),
      }),
    ).rejects.toThrow('generation_upload_failed')

    expect(current).toMatchObject({
      localGeneration: '8',
      cosGeneration: '7',
      dirty: true,
      replicationStatus: 'failed',
    })
    expect(generationRows[0]).toMatchObject({ generation: '9', state: WorkspaceGenerationState.FAILED })

    const startGate = new WorkspacePlacementService(
      {} as any,
      {
        chooseNode: vi.fn().mockResolvedValue({ nodeId: current.ownerNodeId, reason: 'owner_affinity' }),
      } as any,
    )
    const ownerNodeId = current.ownerNodeId
    await expect(
      startGate.assertStartAllowed({
        placement: current as any,
        nodeId: ownerNodeId,
        now: new Date('2026-08-17T00:02:00.000Z'),
      }),
    ).resolves.toBeUndefined()
    expect(workspacePlacementService.releaseWriterLease).toHaveBeenCalled()
  })

  it('retains a committed generation when placement persistence fails after latest publish', async () => {
    const { service, current, generationRows, placementRepository } = setup()
    placementRepository.save.mockRejectedValueOnce(new Error('placement_database_unavailable'))
    const snapshot = checkpoint()
    let latest: string | null = null
    const store = {
      putObjects: vi.fn(),
      putManifest: vi.fn(),
      readManifest: vi.fn(async () => snapshot.manifest),
      putCommittedMarker: vi.fn(),
      getLatest: vi.fn(async () => latest),
      compareAndSetLatest: vi.fn(async (_workspaceKey: string, expected: string | null, generation: string) => {
        if (expected !== latest) return false
        latest = generation
        return true
      }),
    }
    const source = { create: vi.fn(async () => snapshot) }

    await expect(
      service.reconcile({
        placementId: PLACEMENT_ID,
        source,
        store,
        now: new Date('2026-08-17T00:00:00.000Z'),
      }),
    ).rejects.toThrow('generation_persist_failed')

    expect(generationRows[0]).toMatchObject({ generation: '1', state: WorkspaceGenerationState.COMMITTED })
    expect(current).toMatchObject({
      localGeneration: '1',
      cosGeneration: '1',
      dirty: true,
      replicationStatus: 'committed',
    })
    expect(placementRepository.save).toHaveBeenCalledTimes(2)

    const retrySource = { create: vi.fn() }
    await expect(
      service.reconcile({
        placementId: PLACEMENT_ID,
        source: retrySource,
        store,
        now: new Date('2026-08-17T00:01:00.000Z'),
      }),
    ).resolves.toMatchObject({ outcome: 'committed' })
    expect(current).toMatchObject({
      localGeneration: '1',
      cosGeneration: '1',
      dirty: false,
      replicationStatus: 'durable',
    })
    expect(source.create).toHaveBeenCalledOnce()
    expect(retrySource.create).not.toHaveBeenCalled()
  })

  it('retains the checkpoint operation id across a source crash and retry', async () => {
    const { service, generationRows } = setup()
    let fail = true
    const source = {
      create: vi.fn(async () => {
        if (fail) {
          fail = false
          throw new Error('checkpoint interruption')
        }
        return checkpoint()
      }),
    }
    const store = {
      putObjects: vi.fn(),
      putManifest: vi.fn(),
      readManifest: vi.fn().mockResolvedValue(checkpoint().manifest),
      putCommittedMarker: vi.fn(),
      getLatest: vi.fn().mockResolvedValue(null),
      compareAndSetLatest: vi.fn().mockResolvedValue(true),
    }

    await expect(service.reconcile({ placementId: PLACEMENT_ID, source, store })).rejects.toThrow(
      'checkpoint interruption',
    )
    const operationId = generationRows[0].operationId
    expect(generationRows[0]).toMatchObject({ state: WorkspaceGenerationState.FAILED, operationId })

    await expect(service.reconcile({ placementId: PLACEMENT_ID, source, store })).resolves.toMatchObject({
      outcome: 'committed',
    })
    expect(source.create).toHaveBeenLastCalledWith(expect.objectContaining({ operationId }))
  })

  it('rejects an object whose bytes do not match its advertised digest before upload', async () => {
    const { service, current } = setup()
    const invalid = checkpoint()
    invalid.objects[0].sha256 = '0'.repeat(64)
    const store = {
      putObjects: vi.fn(),
      putManifest: vi.fn(),
      readManifest: vi.fn(),
      putCommittedMarker: vi.fn(),
      getLatest: vi.fn(),
      compareAndSetLatest: vi.fn(),
    }

    await expect(
      service.reconcile({
        placementId: PLACEMENT_ID,
        source: { create: vi.fn(async () => invalid) },
        store,
      }),
    ).rejects.toThrow('checkpoint_manifest_invalid')

    expect(store.putObjects).not.toHaveBeenCalled()
    expect(current.cosGeneration).toBe('0')
    expect(current.dirty).toBe(true)
  })

  it('retries latest for a committed generation without creating a new checkpoint', async () => {
    const { service, current, generationRows, generationRepository } = setup()
    current.localGeneration = '1'
    current.cosGeneration = '1'
    const committed = generationRepository.create({
      placementId: PLACEMENT_ID,
      volumeId: VOLUME_ID,
      sandboxId: SANDBOX_ID,
      generation: '1',
      state: WorkspaceGenerationState.COMMITTED,
      sourcePath: 'runner-local-first:test-node',
      manifestHash: 'a'.repeat(64),
      objectCount: '1',
      bytes: '5',
      manifest: {},
      errorCode: null,
      committedAt: new Date('2026-08-17T00:00:00.000Z'),
    })
    generationRows.push(committed)
    const source = { create: vi.fn() }
    const store = {
      putObjects: vi.fn(),
      putManifest: vi.fn(),
      readManifest: vi.fn(),
      putCommittedMarker: vi.fn(),
      getLatest: vi.fn().mockResolvedValue(null),
      compareAndSetLatest: vi.fn().mockResolvedValue(true),
    }

    await expect(service.reconcile({ placementId: PLACEMENT_ID, source, store })).resolves.toMatchObject({
      outcome: 'committed',
      generation: committed,
    })
    expect(source.create).not.toHaveBeenCalled()
    expect(store.compareAndSetLatest).toHaveBeenCalledWith(expect.any(String), null, '1')
    expect(current.dirty).toBe(false)
    expect(current.replicationStatus).toBe('durable')
  })

  it('does not regress local generation when a committed retry observes newer latest', async () => {
    const { service, current, generationRows, generationRepository } = setup()
    current.localGeneration = '1'
    current.cosGeneration = '1'
    const committed = generationRepository.create({
      placementId: PLACEMENT_ID,
      volumeId: VOLUME_ID,
      sandboxId: SANDBOX_ID,
      generation: '2',
      state: WorkspaceGenerationState.COMMITTED,
      sourcePath: 'runner-local-first:test-node',
      manifestHash: 'a'.repeat(64),
      objectCount: '1',
      bytes: '5',
      manifest: {},
      errorCode: null,
      committedAt: new Date('2026-08-17T00:00:00.000Z'),
    })
    generationRows.push(committed)
    const store = {
      putObjects: vi.fn(),
      putManifest: vi.fn(),
      readManifest: vi.fn(),
      putCommittedMarker: vi.fn(),
      getLatest: vi.fn().mockResolvedValue('3'),
      compareAndSetLatest: vi.fn(),
    }

    await expect(
      service.reconcile({ placementId: PLACEMENT_ID, source: { create: vi.fn() }, store }),
    ).resolves.toMatchObject({
      outcome: 'committed',
      generation: committed,
    })

    expect(current.localGeneration).toBe('3')
    expect(current.cosGeneration).toBe('3')
    expect(current.dirty).toBe(false)
    expect(store.compareAndSetLatest).not.toHaveBeenCalled()
  })

  it('keeps a newer local dirty generation visible during an older committed retry', async () => {
    const { service, current, generationRows, generationRepository } = setup()
    current.localGeneration = '1'
    current.cosGeneration = '1'
    const committed = generationRepository.create({
      placementId: PLACEMENT_ID,
      volumeId: VOLUME_ID,
      sandboxId: SANDBOX_ID,
      generation: '2',
      state: WorkspaceGenerationState.COMMITTED,
      sourcePath: 'runner-local-first:test-node',
      manifestHash: 'a'.repeat(64),
      objectCount: '1',
      bytes: '5',
      manifest: {},
      errorCode: null,
      committedAt: new Date('2026-08-17T00:00:00.000Z'),
    })
    generationRows.push(committed)
    const store = {
      putObjects: vi.fn(),
      putManifest: vi.fn(),
      readManifest: vi.fn(),
      putCommittedMarker: vi.fn(),
      getLatest: vi.fn(async () => {
        current.localGeneration = '8'
        current.cosGeneration = '7'
        return '3'
      }),
      compareAndSetLatest: vi.fn(),
    }

    await expect(
      service.reconcile({ placementId: PLACEMENT_ID, source: { create: vi.fn() }, store }),
    ).resolves.toMatchObject({
      outcome: 'committed',
      generation: committed,
    })

    expect(current).toMatchObject({
      localGeneration: '8',
      cosGeneration: '7',
      dirty: true,
      replicationStatus: 'committed',
    })
  })

  it('fails closed when the owner is lost and COS is behind local state', () => {
    expect(
      chooseRecoverySource({
        ownerAvailable: false,
        localGeneration: '8',
        cosGeneration: '7',
        latestCommittedGeneration: '7',
      }),
    ).toBe('recovery_required')
    expect(
      chooseRecoverySource({
        ownerAvailable: false,
        localGeneration: '8',
        cosGeneration: '8',
        latestCommittedGeneration: '8',
      }),
    ).toBe('cos')
  })

  it('does not checkpoint while another writer lease is still active', async () => {
    const { service, current, workspacePlacementService } = setup()
    current.leaseOwner = 'runner:active-writer'
    current.leaseExpiresAt = new Date(Date.now() + 60_000)
    const source = { create: vi.fn() }

    await expect(
      service.reconcile({
        placementId: PLACEMENT_ID,
        source,
        store: {} as any,
      }),
    ).rejects.toThrow('workspace_checkpoint_writer_active')

    expect(source.create).not.toHaveBeenCalled()
    expect(workspacePlacementService.acquireWriterLease).not.toHaveBeenCalled()
  })
})
