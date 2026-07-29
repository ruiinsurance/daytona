/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutBucketTaggingCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { SchedulerRegistry } from '@nestjs/schedule'
import { Redis } from 'ioredis'
import { Repository } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { Volume } from '../entities/volume.entity'
import { VolumeState } from '../enums/volume-state.enum'
import { VolumeManager } from './volume.manager'

const mockS3Send = jest.fn()

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3')
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  }
})

const volumeId = '01932f6e-9df2-7b10-bb66-e198b7c8834a'

type ConfigValues = Record<string, unknown>

function createConfigService(overrides: ConfigValues = {}): TypedConfigService {
  const values: ConfigValues = {
    environment: 'test',
    skipConnections: true,
    's3.endpoint': 'https://cos.ap-shanghai.myqcloud.com',
    's3.region': 'ap-shanghai',
    's3.accessKey': 'test-access-key',
    's3.secretKey': 'test-secret-key',
    's3.defaultBucket': 'daytona-test-1250000000',
    's3.volumeLayout': 'single-bucket-prefix',
    's3.volumePrefix': 'r3-prod/daytona/volumes',
    's3.forcePathStyle': false,
    ...overrides,
  }

  return {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      if (values[key] === undefined) {
        throw new Error(`Missing test config: ${key}`)
      }
      return values[key]
    }),
  } as unknown as TypedConfigService
}

function createVolume(state: VolumeState, id = volumeId): Volume {
  return Object.assign(new Volume(), {
    id,
    organizationId: 'org-1',
    name: 'user-data',
    state,
  })
}

function createManager(volume: Volume, configService = createConfigService()) {
  const volumeRepository = {
    find: jest.fn().mockResolvedValue([volume]),
    save: jest.fn().mockImplementation(async (value) => value),
    update: jest.fn(),
    delete: jest.fn(),
  } as unknown as Repository<Volume>
  const redis = {
    setex: jest.fn().mockResolvedValue('OK'),
  } as unknown as Redis
  const redisLockProvider = {
    lock: jest.fn().mockResolvedValue(true),
    unlock: jest.fn().mockResolvedValue(undefined),
  } as unknown as RedisLockProvider

  return {
    manager: new VolumeManager(volumeRepository, configService, redis, redisLockProvider, {} as SchedulerRegistry),
    volumeRepository,
  }
}

describe('VolumeManager', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockS3Send.mockResolvedValue({})
  })

  it('creates a single-bucket volume under its canonical prefix without mutating the shared bucket', async () => {
    const volume = createVolume(VolumeState.PENDING_CREATE)
    const { manager, volumeRepository } = createManager(volume)

    await manager.processPendingVolumes()

    const commands = mockS3Send.mock.calls.map(([command]) => command)
    expect(commands.some((command) => command instanceof CreateBucketCommand)).toBe(false)
    expect(commands.some((command) => command instanceof PutBucketTaggingCommand)).toBe(false)
    expect(commands.find((command) => command instanceof HeadBucketCommand)?.input).toEqual({
      Bucket: 'daytona-test-1250000000',
    })
    expect(commands.find((command) => command instanceof PutObjectCommand)?.input).toMatchObject({
      Bucket: 'daytona-test-1250000000',
      Key: `r3-prod/daytona/volumes/${volumeId}/.daytona-volume`,
    })
    expect(volumeRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: volumeId, state: VolumeState.READY }),
    )
    expect(S3Client).toHaveBeenCalledTimes(1)
  })

  it('preserves per-volume bucket creation by default', async () => {
    const volume = createVolume(VolumeState.PENDING_CREATE)
    const { manager } = createManager(
      volume,
      createConfigService({
        's3.volumeLayout': 'per-volume-bucket',
      }),
    )

    await manager.processPendingVolumes()

    const commands = mockS3Send.mock.calls.map(([command]) => command)
    expect(commands.find((command) => command instanceof CreateBucketCommand)?.input).toEqual({
      Bucket: `daytona-volume-${volumeId}`,
    })
    expect(commands.find((command) => command instanceof PutBucketTaggingCommand)?.input).toMatchObject({
      Bucket: `daytona-volume-${volumeId}`,
      Tagging: {
        TagSet: expect.arrayContaining([
          { Key: 'VolumeId', Value: volumeId },
          { Key: 'OrganizationId', Value: 'org-1' },
          { Key: 'Environment', Value: 'test' },
        ]),
      },
    })
    expect(commands.some((command) => command instanceof HeadBucketCommand)).toBe(false)
  })

  it('configures virtual-hosted style for COS endpoints', () => {
    createManager(
      createVolume(VolumeState.PENDING_CREATE),
      createConfigService({
        's3.forcePathStyle': false,
      }),
    )

    expect(S3Client).toHaveBeenCalledWith(expect.objectContaining({ forcePathStyle: false }))
  })

  it('checks only the configured fixed bucket when testing the COS connection', async () => {
    const { manager } = createManager(
      createVolume(VolumeState.PENDING_CREATE),
      createConfigService({
        skipConnections: false,
      }),
    )

    await manager.onModuleInit()

    const commands = mockS3Send.mock.calls.map(([command]) => command)
    expect(commands.find((command) => command instanceof HeadBucketCommand)?.input).toEqual({
      Bucket: 'daytona-test-1250000000',
    })
    expect(commands.some((command) => command instanceof ListBucketsCommand)).toBe(false)
  })

  it('deletes only the canonical volume prefix across every object page', async () => {
    const prefix = `r3-prod/daytona/volumes/${volumeId}/`
    const siblingKey = 'r3-prod/daytona/volumes/01932f6e-9df2-7b10-bb66-e198b7c8834b/keep.txt'
    mockS3Send.mockImplementation(async (command) => {
      if (command instanceof ListObjectsV2Command && !command.input.ContinuationToken) {
        return {
          Contents: [{ Key: `${prefix}.daytona-volume` }, { Key: `${prefix}sandboxes/sandbox-1/workspace/a.txt` }],
          IsTruncated: true,
          NextContinuationToken: 'page-2',
        }
      }
      if (command instanceof ListObjectsV2Command) {
        return {
          Contents: [{ Key: `${prefix}sandboxes/sandbox-2/workspace/b.txt` }, { Key: siblingKey }],
          IsTruncated: false,
        }
      }
      return {}
    })
    const volume = createVolume(VolumeState.PENDING_DELETE)
    const { manager, volumeRepository } = createManager(volume)

    await manager.processPendingVolumes()

    const commands = mockS3Send.mock.calls.map(([command]) => command)
    expect(commands.some((command) => command instanceof DeleteBucketCommand)).toBe(false)
    expect(
      commands.filter((command) => command instanceof ListObjectsV2Command).map((command) => command.input),
    ).toEqual([
      { Bucket: 'daytona-test-1250000000', Prefix: prefix },
      { Bucket: 'daytona-test-1250000000', Prefix: prefix, ContinuationToken: 'page-2' },
    ])
    const deletedKeys = commands
      .filter((command) => command instanceof DeleteObjectsCommand)
      .flatMap((command) => command.input.Delete?.Objects || [])
      .map((object) => object.Key)
    expect(deletedKeys).toEqual([
      `${prefix}.daytona-volume`,
      `${prefix}sandboxes/sandbox-1/workspace/a.txt`,
      `${prefix}sandboxes/sandbox-2/workspace/b.txt`,
    ])
    expect(deletedKeys).not.toContain(siblingKey)
    expect(volumeRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: volumeId, state: VolumeState.DELETED, name: 'user-data-deleted' }),
    )
  })

  it('deletes every object version and delete marker only within the volume prefix', async () => {
    const prefix = `r3-prod/daytona/volumes/${volumeId}/`
    mockS3Send.mockImplementation(async (command) => {
      if (command instanceof ListObjectVersionsCommand && !command.input.KeyMarker) {
        return {
          Versions: [{ Key: `${prefix}versioned.txt`, VersionId: 'v1' }],
          DeleteMarkers: [{ Key: `${prefix}deleted.txt`, VersionId: 'd1' }],
          IsTruncated: true,
          NextKeyMarker: 'next-key',
          NextVersionIdMarker: 'next-version',
        }
      }
      if (command instanceof ListObjectVersionsCommand) {
        return {
          Versions: [
            { Key: `${prefix}versioned.txt`, VersionId: 'v2' },
            { Key: 'r3-prod/daytona/volumes/sibling/keep.txt', VersionId: 'keep' },
          ],
          IsTruncated: false,
        }
      }
      return {}
    })
    const { manager } = createManager(createVolume(VolumeState.PENDING_DELETE))

    await manager.processPendingVolumes()

    const commands = mockS3Send.mock.calls.map(([command]) => command)
    expect(
      commands.filter((command) => command instanceof ListObjectVersionsCommand).map((command) => command.input),
    ).toEqual([
      { Bucket: 'daytona-test-1250000000', Prefix: prefix },
      {
        Bucket: 'daytona-test-1250000000',
        Prefix: prefix,
        KeyMarker: 'next-key',
        VersionIdMarker: 'next-version',
      },
    ])
    const deletedVersions = commands
      .filter((command) => command instanceof DeleteObjectsCommand)
      .flatMap((command) => command.input.Delete?.Objects || [])
      .filter((object) => object.VersionId)
    expect(deletedVersions).toEqual([
      { Key: `${prefix}versioned.txt`, VersionId: 'v1' },
      { Key: `${prefix}deleted.txt`, VersionId: 'd1' },
      { Key: `${prefix}versioned.txt`, VersionId: 'v2' },
    ])
  })

  it('batches scoped deletions at the S3 limit', async () => {
    const prefix = `r3-prod/daytona/volumes/${volumeId}/`
    mockS3Send.mockImplementation(async (command) => {
      if (command instanceof ListObjectVersionsCommand) {
        return {
          Versions: Array.from({ length: 1001 }, (_, index) => ({
            Key: `${prefix}object-${index}`,
            VersionId: `version-${index}`,
          })),
        }
      }
      return {}
    })
    const { manager } = createManager(createVolume(VolumeState.PENDING_DELETE))

    await manager.processPendingVolumes()

    const batchSizes = mockS3Send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof DeleteObjectsCommand)
      .map((command) => command.input.Delete?.Objects?.length)
    expect(batchSizes).toEqual([1000, 1])
  })

  it('does not mark a volume deleted when COS reports an object deletion error', async () => {
    const prefix = `r3-prod/daytona/volumes/${volumeId}/`
    mockS3Send.mockImplementation(async (command) => {
      if (command instanceof ListObjectsV2Command) {
        return { Contents: [{ Key: `${prefix}protected.txt` }] }
      }
      if (command instanceof DeleteObjectsCommand) {
        return {
          Errors: [{ Key: `${prefix}protected.txt`, Code: 'AccessDenied', Message: 'denied' }],
        }
      }
      return {}
    })
    const { manager, volumeRepository } = createManager(createVolume(VolumeState.PENDING_DELETE))

    await manager.processPendingVolumes()

    expect(volumeRepository.save).not.toHaveBeenCalledWith(expect.objectContaining({ state: VolumeState.DELETED }))
    expect(volumeRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        state: VolumeState.ERROR,
        errorReason: expect.stringContaining('failed to delete 1 object'),
      }),
    )
  })

  it('rejects a non-canonical volume UUID before accessing the shared bucket', async () => {
    const invalidVolume = createVolume(VolumeState.PENDING_CREATE, volumeId.toUpperCase())
    const { manager, volumeRepository } = createManager(invalidVolume)

    await manager.processPendingVolumes()

    expect(mockS3Send).not.toHaveBeenCalled()
    expect(volumeRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: volumeId.toUpperCase(),
        state: VolumeState.ERROR,
        errorReason: expect.stringContaining('canonical lowercase UUID'),
      }),
    )
  })

  it.each([
    '',
    '/r3-prod/daytona/volumes',
    'r3-prod/../volumes',
    'r3-prod/./volumes',
    'r3-prod//daytona/volumes',
    'r3-prod\\daytona\\volumes',
    'r3-prod/daytona/volumes/',
  ])('rejects unsafe volume prefix %p before accessing the shared bucket', async (unsafePrefix) => {
    const { manager, volumeRepository } = createManager(
      createVolume(VolumeState.PENDING_CREATE),
      createConfigService({
        's3.volumePrefix': unsafePrefix,
      }),
    )

    await manager.processPendingVolumes()

    expect(mockS3Send).not.toHaveBeenCalled()
    expect(volumeRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: volumeId,
        state: VolumeState.ERROR,
        errorReason: expect.stringContaining('volume prefix'),
      }),
    )
  })

  it.each(['', ' shared-bucket', 'shared/bucket', 'shared\\bucket'])(
    'rejects unsafe fixed bucket %p before accessing S3',
    async (unsafeBucket) => {
      const { manager, volumeRepository } = createManager(
        createVolume(VolumeState.PENDING_DELETE),
        createConfigService({
          's3.defaultBucket': unsafeBucket,
        }),
      )

      await manager.processPendingVolumes()

      expect(mockS3Send).not.toHaveBeenCalled()
      expect(volumeRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: volumeId,
          state: VolumeState.ERROR,
          errorReason: expect.stringContaining('fixed S3 bucket'),
        }),
      )
    },
  )

  it('rejects an unknown volume layout instead of falling back to bucket creation', () => {
    expect(() =>
      createManager(
        createVolume(VolumeState.PENDING_CREATE),
        createConfigService({
          's3.volumeLayout': 'single-bucket-prefx',
        }),
      ),
    ).toThrow('Unsupported S3 volume layout')
  })
})
