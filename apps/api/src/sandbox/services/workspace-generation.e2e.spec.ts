import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  checkpointContentHash,
  buildGenerationObjectKey,
  buildWorkspaceGenerationKey,
} from '../local-first/workspace-generation.contract'
import { WorkspaceGenerationReconciler, WorkspaceGenerationWorker } from './workspace-generation-worker.service'
import { S3GenerationObjectStore, WorkspaceGenerationService } from './workspace-generation.service'

const PLACEMENT_ID = '11111111-1111-4111-8111-111111111111'
const VOLUME_ID = '22222222-2222-4222-8222-222222222222'
const SANDBOX_ID = '33333333-3333-4333-8333-333333333333'
const OWNER_NODE_ID = '44444444-4444-4444-8444-444444444444'

const runE2E = process.env.DAYTONA_TEST_S3_ENDPOINT ? describe : describe.skip
let activeClient: S3Client
let activeBucket = ''
let activeWorkspaceKey = ''

runE2E('WorkspaceGenerationWorker application S3 E2E', () => {
  const bucket = process.env.DAYTONA_TEST_S3_BUCKET ?? 'issue572'
  const prefix = `issue-572-e2e/${process.env.DAYTONA_TEST_RUN_ID ?? Date.now()}`
  const workspaceKey = buildWorkspaceGenerationKey(VOLUME_ID, SANDBOX_ID, prefix)

  beforeAll(async () => {
    activeClient = new S3Client({
      endpoint: process.env.DAYTONA_TEST_S3_ENDPOINT,
      region: process.env.DAYTONA_TEST_S3_REGION ?? 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.DAYTONA_TEST_S3_ACCESS_KEY ?? 'issue572',
        secretAccessKey: process.env.DAYTONA_TEST_S3_SECRET_KEY ?? 'issue572-minio-test',
      },
    })
    activeBucket = bucket
    activeWorkspaceKey = workspaceKey
    try {
      await activeClient.send(new HeadBucketCommand({ Bucket: bucket }))
    } catch {
      await activeClient.send(new CreateBucketCommand({ Bucket: bucket }))
    }
  })

  afterAll(() => {
    activeClient?.destroy()
  })

  it('runs the reconciler against S3 and publishes only a complete generation', async () => {
    const current = {
      id: PLACEMENT_ID,
      volumeId: VOLUME_ID,
      subpath: `sandboxes/${SANDBOX_ID}/workspace`,
      sandboxId: SANDBOX_ID,
      ownerNodeId: OWNER_NODE_ID,
      localGeneration: '0',
      cosGeneration: '0',
      fenceEpoch: '1',
      leaseOwner: null,
      leaseExpiresAt: null,
      replicationStatus: 'pending',
      dirty: true,
    }
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
      prefix,
    )
    const source = { create: vi.fn(async () => checkpoint()) }
    const reconciler = new WorkspaceGenerationReconciler(
      {
        createQueryBuilder: vi.fn(() => ({
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          take: vi.fn().mockReturnThis(),
          getMany: vi.fn().mockResolvedValue([current]),
        })),
      } as any,
      service,
      source,
      new S3GenerationObjectStore(activeClient, bucket, prefix),
      10,
    )
    const worker = new WorkspaceGenerationWorker(reconciler)

    await expect(worker.reconcileOnce()).resolves.toBe(1)
    expect(current).toMatchObject({
      localGeneration: '1',
      cosGeneration: '1',
      dirty: false,
      replicationStatus: 'durable',
    })
    expect(await readLatest()).toBe('1')

    const generationOnePrefix = `${workspaceKey}/1/`
    const listed = await activeClient.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: generationOnePrefix }))
    expect((listed.Contents ?? []).map((object) => object.Key)).toEqual(
      expect.arrayContaining([
        `${generationOnePrefix}state.db`,
        `${generationOnePrefix}manifest.json`,
        `${generationOnePrefix}_COMMITTED`,
      ]),
    )
    expect(await readText(`${generationOnePrefix}state.db`)).toBe('state')
  })

  it('keeps latest on the committed generation when a newer upload is partial', async () => {
    const latestBefore = await readLatest()
    expect(latestBefore).toBe('1')
    const partialManifest = {
      ...checkpoint().manifest,
      generation: '2',
    }
    const partialPrefix = `${workspaceKey}/2/`
    await activeClient.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: buildGenerationObjectKey(workspaceKey, '2', 'state.db'),
        Body: 'partial',
      }),
    )
    await activeClient.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: buildGenerationObjectKey(workspaceKey, '2', 'manifest.json'),
        Body: JSON.stringify(partialManifest),
        ContentType: 'application/json',
      }),
    )

    await expect(readLatest()).resolves.toBe('1')
    await expect(
      activeClient.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: `${partialPrefix}_COMMITTED`,
        }),
      ),
    ).rejects.toBeTruthy()
  })
})

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

async function readLatest(): Promise<string | null> {
  const response = await activeClient.send(
    new GetObjectCommand({
      Bucket: activeBucket,
      Key: `${activeWorkspaceKey}/latest`,
    }),
  )
  const text = await response.Body?.transformToString()
  if (!text) return null
  return (JSON.parse(text) as { generation: string }).generation
}

async function readText(key: string): Promise<string> {
  const response = await activeClient.send(
    new GetObjectCommand({
      Bucket: activeBucket,
      Key: key,
    }),
  )
  return (await response.Body?.transformToString()) ?? ''
}
