/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1787000000002 implements MigrationInterface {
  name = 'Migration1787000000002'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "workspace_generation" ADD "operationId" uuid')
    await queryRunner.query(
      'UPDATE "workspace_generation" SET "operationId" = uuid_generate_v4() WHERE "operationId" IS NULL',
    )
    await queryRunner.query('ALTER TABLE "workspace_generation" ALTER COLUMN "operationId" SET NOT NULL')
    await queryRunner.query(
      'CREATE UNIQUE INDEX "workspace_generation_operation_unique" ON "workspace_generation" ("operationId")',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "workspace_generation_operation_unique"')
    await queryRunner.query('ALTER TABLE "workspace_generation" DROP COLUMN "operationId"')
  }
}
