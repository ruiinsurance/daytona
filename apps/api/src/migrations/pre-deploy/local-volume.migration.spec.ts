/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { QueryRunner } from 'typeorm'
import { Migration1787366200699 } from './1787366200699-migration'

describe('local volume migration', () => {
  it('adds backward-compatible defaults and reverses in dependency order', async () => {
    const queries: string[] = []
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql)
      }),
    } as unknown as QueryRunner
    const migration = new Migration1787366200699()

    await migration.up(queryRunner)
    expect(queries).toEqual([
      `ALTER TABLE "sandbox" ADD "storageBackend" character varying NOT NULL DEFAULT 'cos'`,
      `ALTER TABLE "runner" ADD "localVolumeEnabled" boolean NOT NULL DEFAULT false`,
    ])

    queries.length = 0
    await migration.down(queryRunner)
    expect(queries).toEqual([
      `ALTER TABLE "runner" DROP COLUMN "localVolumeEnabled"`,
      `ALTER TABLE "sandbox" DROP COLUMN "storageBackend"`,
    ])
  })
})
