/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException } from '@nestjs/common'
import { VolumeState } from '../enums/volume-state.enum'
import { VolumeService } from './volume.service'

const volumeId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'

function serviceWithRepository(repository: Record<string, jest.Mock>): VolumeService {
  return new VolumeService(repository as never, {} as never, {} as never, {} as never, {} as never, {} as never)
}

describe('VolumeService restored local Volume registration', () => {
  it('registers an exact pre-restored local Volume as ready without a storage create operation', async () => {
    const repository = {
      findOne: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockResolvedValue(undefined),
    }
    const service = serviceWithRepository(repository)

    await expect(service.registerRestoredLocalVolume(volumeId, organizationId)).resolves.toMatchObject({
      id: volumeId,
      name: volumeId,
      organizationId,
      state: VolumeState.READY,
    })
    expect(repository.insert).toHaveBeenCalledWith(
      expect.objectContaining({ id: volumeId, organizationId, state: VolumeState.READY }),
    )
  })

  it('replays an existing exact ready registration without writing it again', async () => {
    const existing = { id: volumeId, name: volumeId, organizationId, state: VolumeState.READY }
    const repository = {
      findOne: jest.fn().mockResolvedValue(existing),
      insert: jest.fn(),
    }
    const service = serviceWithRepository(repository)

    await expect(service.registerRestoredLocalVolume(volumeId, organizationId)).resolves.toBe(existing)
    expect(repository.insert).not.toHaveBeenCalled()
  })

  it('rejects an existing Volume owned by another organization', async () => {
    const repository = {
      findOne: jest.fn().mockResolvedValue({
        id: volumeId,
        name: volumeId,
        organizationId: '33333333-3333-4333-8333-333333333333',
        state: VolumeState.READY,
      }),
      insert: jest.fn(),
    }
    const service = serviceWithRepository(repository)

    await expect(service.registerRestoredLocalVolume(volumeId, organizationId)).rejects.toBeInstanceOf(
      ConflictException,
    )
    expect(repository.insert).not.toHaveBeenCalled()
  })
})
