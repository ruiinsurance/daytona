/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, INestApplication, UnauthorizedException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import axios from 'axios'
import { AllExceptionsFilter } from '../../filters/all-exceptions.filter'
import { FailedAuthTrackerService } from '../../auth/failed-auth-tracker.service'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { OrganizationAuthContextGuard } from '../../organization/guards/organization-auth-context.guard'
import { LocalSandboxStorageIdentityError } from '../errors/local-sandbox-storage-identity.error'
import { SandboxAccessGuard } from '../guards/sandbox-access.guard'
import { SandboxRebuildService } from '../services/sandbox-rebuild.service'
import { SandboxRebuildController } from './sandbox-rebuild.controller'

const sandboxId = '11111111-1111-4111-8111-111111111111'
const operationId = '22222222-2222-4222-8222-222222222222'
const organizationId = '33333333-3333-4333-8333-333333333333'
const ownerRunnerId = '44444444-4444-4444-8444-444444444444'
const input = { operationId, targetSnapshot: 'target-snapshot' }
const retainedIdentity = { ...input, sandboxId, ownerRunnerId, previousSnapshot: 'old-snapshot' }

// Run in GitHub/UAT only. This exercises the production HTTP filter, unlike
// controller tests that inspect HttpException.getResponse() directly. Auth is a
// fixed test context; this suite does not establish production auth acceptance.
describe('rebuild protocol through the real Nest HTTP exception pipeline', () => {
  let app: INestApplication
  let baseUrl: string
  const service = { rebuild: jest.fn(), getEligibility: jest.fn() }
  const tracker = new FailedAuthTrackerService({} as never, {} as never)

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SandboxRebuildController],
      providers: [{ provide: SandboxRebuildService, useValue: service }],
    })
      .overrideGuard(AuthenticatedRateLimitGuard).useValue({ canActivate: () => true })
      .overrideGuard(OrganizationAuthContextGuard).useValue({ canActivate: () => true })
      .overrideGuard(SandboxAccessGuard).useValue({ canActivate: () => true })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.use((request, _response, next) => {
      request.user = { role: 'admin', userId: 'test-user', organizationId, organization: {}, organizationUser: {} }
      next()
    })
    app.useGlobalFilters(new AllExceptionsFilter(tracker))
    await app.listen(0, '127.0.0.1')
    baseUrl = await app.getUrl()
  })

  afterAll(async () => { await app?.close() })
  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(tracker, 'incrementFailedAuth').mockResolvedValue(undefined)
  })
  afterEach(() => { jest.restoreAllMocks() })

  async function postRebuild() {
    const response = await fetch(`${baseUrl}/api/sandbox/${sandboxId}/rebuild`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    })
    return { status: response.status, body: await response.json() }
  }

  it.each([
    ['rebuild_preflight_failed', 409, true],
    ['rebuild_failed_previous_restored', 409, true],
    ['operation_in_progress', 409, true],
    ['rebuild_failed_rollback_failed', 500, false],
    ['operation_outcome_unknown', 500, false],
  ] as const)('preserves %s and exact operation identity on the wire', async (outcome, status, retryable) => {
    const identity = outcome === 'operation_in_progress' || outcome === 'operation_outcome_unknown'
      ? { ...input, sandboxId }
      : retainedIdentity
    // A future service diagnostic must not accidentally become a public field.
    service.rebuild.mockResolvedValue({ ...identity, outcome, internalDiagnostic: 'PRIVATE-DIAGNOSTIC' })
    const result = await postRebuild()
    expect(result.status).toBe(status)
    expect(result.body).toEqual({
      ...identity, outcome, code: outcome, success: false, retryable,
      path: `/api/sandbox/${sandboxId}/rebuild`, timestamp: expect.any(String), statusCode: status,
      error: status === 409 ? 'Conflict' : 'Internal Server Error', message: expect.any(String),
    })
    expect(service.rebuild).toHaveBeenCalledTimes(1)
    expect(service.rebuild).toHaveBeenCalledWith(sandboxId, organizationId, input)
    expect(service.getEligibility).not.toHaveBeenCalled()
  })

  it('retains a successful rebuild response', async () => {
    service.rebuild.mockResolvedValue({ ...retainedIdentity, outcome: 'rebuilt' })
    expect(await postRebuild()).toEqual({
      status: 200, body: { ...retainedIdentity, outcome: 'rebuilt', code: 'rebuilt', success: true },
    })
  })

  it.each([
    ['control_plane_inconsistent', { state: 'destroyed', desiredState: 'destroyed', runnerId: null }, true],
    ['remote_operation_unresolved', {}, false],
    ['historical_identity_requires_review', { name: 'DESTROYED_retained' }, true],
  ])('preserves %s from the actual eligibility service without runtime side effects', async (code, changes, lockHeld) => {
    const sandbox = { id: sandboxId, name: 'visible', state: 'started', desiredState: 'started',
      runnerId: ownerRunnerId, snapshot: 'old-snapshot', pending: false, ...changes }
    const repository = { findOneOrFail: jest.fn(async () => sandbox) }
    const runner = { findOne: jest.fn() }
    const factory = { create: jest.fn() }
    const snapshots = { getSnapshotByName: jest.fn() }
    const lock = { lock: jest.fn(async () => lockHeld), unlockOwned: jest.fn(async () => true) }
    const eligibility = new SandboxRebuildService(repository as never, runner as never, factory as never,
      snapshots as never, {} as never, {} as never, {} as never, {} as never, lock as never, {} as never)
    service.getEligibility.mockImplementation((id, org) => eligibility.getEligibility(id, org))
    const inspect = jest.spyOn(axios, 'post')
    const response = await fetch(`${baseUrl}/api/sandbox/${sandboxId}/rebuild-eligibility`)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code, statusCode: 409 })
    expect(service.getEligibility).toHaveBeenCalledWith(sandboxId, organizationId)
    expect(service.rebuild).not.toHaveBeenCalled()
    expect(runner.findOne).not.toHaveBeenCalled()
    expect(factory.create).not.toHaveBeenCalled()
    expect(snapshots.getSnapshotByName).not.toHaveBeenCalled()
    expect(inspect).not.toHaveBeenCalled()
  })

  it('preserves the fixed storage identity code without exposing internal details', async () => {
    service.rebuild.mockRejectedValue(new LocalSandboxStorageIdentityError())
    const result = await postRebuild()
    expect(result.status).toBe(409)
    expect(result.body).toEqual({
      code: 'storage_identity_invalid', statusCode: 409, error: 'Conflict',
      message: 'The sandbox local Volume or mount identity could not be verified',
      path: `/api/sandbox/${sandboxId}/rebuild`, timestamp: expect.any(String),
    })
  })

  it('keeps arbitrary HttpException bodies private even on the rebuild route', async () => {
    service.rebuild.mockRejectedValue(new HttpException({
      message: 'Safe public message', code: 'rebuild_preflight_failed', outcome: 'rebuild_preflight_failed',
      operationId, retryable: true, token: 'PRIVATE-TOKEN', config: { password: 'PRIVATE-PASSWORD' },
    }, 409))
    const result = await postRebuild()
    expect(result.status).toBe(409)
    expect(result.body).toEqual({
      path: `/api/sandbox/${sandboxId}/rebuild`, timestamp: expect.any(String), statusCode: 409,
      error: 'Conflict', message: 'Safe public message',
    })
  })

  it('still tracks authentication failures without exposing exception extras', async () => {
    service.rebuild.mockRejectedValue(new UnauthorizedException({ message: 'Unauthorized', token: 'PRIVATE-TOKEN' }))
    const result = await postRebuild()
    expect(result.status).toBe(401)
    expect(result.body).toEqual({
      path: `/api/sandbox/${sandboxId}/rebuild`, timestamp: expect.any(String), statusCode: 401,
      error: 'Unauthorized', message: 'Unauthorized',
    })
    expect(tracker.incrementFailedAuth).toHaveBeenCalledTimes(1)
  })
})
