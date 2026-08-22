/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1787366200699 implements MigrationInterface {
  name = 'Migration1787366200699'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sandbox" ADD "storageBackend" character varying NOT NULL DEFAULT 'cos'`)
    await queryRunner.query(`ALTER TABLE "runner" ADD "localVolumeEnabled" boolean NOT NULL DEFAULT false`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runner" DROP COLUMN "localVolumeEnabled"`)
    await queryRunner.query(`ALTER TABLE "sandbox" DROP COLUMN "storageBackend"`)
  }
}
