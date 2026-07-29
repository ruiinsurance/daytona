/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ServiceUnavailableException } from '@nestjs/common'
import axios from 'axios'
import { TypedConfigService } from '../../config/typed-config.service'
import { ObjectStorageService } from './object-storage.service'

jest.mock('axios')
jest.mock('aws4')

describe('ObjectStorageService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('disables push access in single-bucket COS mode without reading long-lived credentials', async () => {
    const configService = {
      get: jest.fn((key: string) => {
        const values = {
          's3.endpoint': 'https://cos.ap-shanghai.myqcloud.com',
          's3.volumeLayout': 'single-bucket-prefix',
          's3.stsProvider': 'disabled',
        }
        return values[key]
      }),
      getOrThrow: jest.fn(() => {
        throw new Error('long-lived credentials must not be read')
      }),
    } as unknown as TypedConfigService
    const service = new ObjectStorageService(configService)

    await expect(service.getPushAccess('org-1')).rejects.toEqual(
      new ServiceUnavailableException('Object storage push access is disabled for single-bucket-prefix volumes'),
    )
    expect(configService.getOrThrow).not.toHaveBeenCalled()
  })

  it('honors an explicit MinIO STS provider without relying on the endpoint name', async () => {
    const values = {
      's3.endpoint': 'https://storage.example.test',
      's3.volumeLayout': 'per-volume-bucket',
      's3.stsProvider': 'minio',
      's3.defaultBucket': 'daytona',
      's3.stsEndpoint': 'https://sts.example.test/assume-role',
      's3.accessKey': 'test-access-key',
      's3.secretKey': 'test-secret-key',
      's3.region': 'us-east-1',
      's3.accountId': '/',
      's3.roleName': '/',
    }
    const configService = {
      get: jest.fn((key: string) => values[key]),
      getOrThrow: jest.fn((key: string) => values[key]),
    } as unknown as TypedConfigService
    jest.mocked(axios.post).mockResolvedValue({
      data: `
        <AssumeRoleResponse>
          <AssumeRoleResult>
            <Credentials>
              <AccessKeyId>temporary-key</AccessKeyId>
              <SecretAccessKey>temporary-secret</SecretAccessKey>
              <SessionToken>temporary-token</SessionToken>
            </Credentials>
          </AssumeRoleResult>
        </AssumeRoleResponse>
      `,
    })
    const service = new ObjectStorageService(configService)

    await expect(service.getPushAccess('org-1')).resolves.toMatchObject({
      accessKey: 'temporary-key',
      secret: 'temporary-secret',
      sessionToken: 'temporary-token',
    })
    expect(axios.post).toHaveBeenCalledWith(
      'https://sts.example.test/assume-role',
      expect.any(String),
      expect.objectContaining({ headers: expect.any(Object) }),
    )
  })
})
