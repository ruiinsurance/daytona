/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'

vi.mock('typeorm', () => {
  const decorator = () => () => undefined
  return {
    Column: decorator,
    CreateDateColumn: decorator,
    Entity: decorator,
    Index: decorator,
    JoinColumn: decorator,
    ManyToOne: decorator,
    OneToOne: decorator,
    PrimaryColumn: decorator,
    Unique: decorator,
    UpdateDateColumn: decorator,
  }
})

// The direct Vitest transform does not load the application tsconfig's
// decorator metadata. These relation targets are irrelevant to constructor
// identity behavior, so keep this unit seam independent of their entity graph.
vi.mock('./build-info.entity', () => ({ BuildInfo: class BuildInfo {} }))
vi.mock('./sandbox-last-activity.entity', () => ({ SandboxLastActivity: class SandboxLastActivity {} }))

import { Sandbox } from './sandbox.entity'

describe('Sandbox stable identity', () => {
  it('uses the supplied identity when creating a sandbox', () => {
    const sandbox = new Sandbox({
      id: '11111111-1111-4111-8111-111111111111',
      region: 'us',
      name: 'stable-sandbox',
    })

    expect(sandbox.id).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('keeps random UUID generation for legacy callers', () => {
    const sandbox = new Sandbox({ region: 'us', name: 'legacy-sandbox' })

    expect(sandbox.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('rejects a malformed supplied identity even when the entity is called directly', () => {
    expect(
      () =>
        new Sandbox({
          id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
          region: 'us',
          name: 'invalid-sandbox',
        }),
    ).toThrow('Invalid sandbox identity')
  })
})
