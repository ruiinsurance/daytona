/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1787392524000 implements MigrationInterface {
  name = 'Migration1787392524000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sandbox" ALTER COLUMN "storageBackend" SET DEFAULT 'local'`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sandbox" ALTER COLUMN "storageBackend" SET DEFAULT 'cos'`)
  }
}
