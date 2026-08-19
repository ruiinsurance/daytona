import { describe, expect, it, vi } from 'vitest'
import { AppService } from './app.service'

describe('AppService bootstrap logging', () => {
  it('does not write the generated admin API key to logs', async () => {
    const adminApiKey = 'sensitive-test-admin-key'
    const configValues: Record<string, unknown> = {
      'admin.apiKey': adminApiKey,
      'admin.totalCpuQuota': 10,
      'admin.totalMemoryQuota': 10,
      'admin.totalDiskQuota': 30,
      'admin.maxCpuPerSandbox': 4,
      'admin.maxMemoryPerSandbox': 8,
      'admin.maxDiskPerSandbox': 10,
      'admin.snapshotQuota': 30,
      'admin.maxSnapshotSize': 20,
      'admin.volumeQuota': 100,
      'defaultRegion.id': 'test-region',
    }
    const logger = { log: vi.fn() }
    const appService = Object.create(AppService.prototype) as AppService & {
      logger: typeof logger
      configService: { getOrThrow: (key: string) => unknown }
      userService: { findOne: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }
      organizationService: { findPersonal: ReturnType<typeof vi.fn> }
      apiKeyService: { createApiKey: ReturnType<typeof vi.fn> }
      initializeAdminUser: () => Promise<void>
    }

    appService.logger = logger
    appService.configService = {
      getOrThrow: (key) => configValues[key],
    }
    appService.userService = {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'daytona-admin' }),
    }
    appService.organizationService = {
      findPersonal: vi.fn().mockResolvedValue({ id: 'test-organization' }),
    }
    appService.apiKeyService = {
      createApiKey: vi.fn().mockResolvedValue({ value: adminApiKey }),
    }

    await appService.initializeAdminUser()

    const loggedText = logger.log.mock.calls.flat().join(' ')
    expect(loggedText).toContain('Admin user created')
    expect(loggedText).not.toContain(adminApiKey)
  })
})
