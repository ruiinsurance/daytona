/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1787000000001 implements MigrationInterface {
  name = 'Migration1787000000001'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "workspace_generation" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "placementId" uuid NOT NULL,
        "volumeId" character varying NOT NULL,
        "sandboxId" uuid NOT NULL,
        "generation" bigint NOT NULL,
        "state" character varying(24) NOT NULL,
        "sourcePath" character varying(1024) NOT NULL,
        "manifestHash" character varying(128) NOT NULL,
        "objectCount" bigint NOT NULL DEFAULT '0',
        "bytes" bigint NOT NULL DEFAULT '0',
        "manifest" jsonb NOT NULL,
        "errorCode" character varying(64),
        "committedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "workspace_generation_pk" PRIMARY KEY ("id"),
        CONSTRAINT "workspace_generation_placement_generation_unique" UNIQUE ("placementId", "generation")
      )
    `)
    await queryRunner.query(`CREATE INDEX "workspace_generation_placement_state_idx" ON "workspace_generation" ("placementId", "state")`)
    await queryRunner.query(`
      CREATE TABLE "workspace_operation" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "type" character varying(32) NOT NULL DEFAULT 'move',
        "phase" character varying(32) NOT NULL,
        "placementId" uuid NOT NULL,
        "volumeId" character varying NOT NULL,
        "sandboxId" uuid NOT NULL,
        "sourceNodeId" uuid NOT NULL,
        "targetNodeId" uuid NOT NULL,
        "idempotencyKey" character varying(128) NOT NULL,
        "leaseOwner" character varying(128),
        "leaseExpiresAt" TIMESTAMP WITH TIME ZONE,
        "expectedFenceEpoch" bigint NOT NULL,
        "checkpointGeneration" bigint,
        "targetGeneration" bigint,
        "targetManifestHash" character varying(128),
        "switchedFenceEpoch" bigint,
        "errorCode" character varying(64),
        "sourceRetained" boolean NOT NULL DEFAULT false,
        "completedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "workspace_operation_pk" PRIMARY KEY ("id"),
        CONSTRAINT "workspace_operation_idempotency_unique" UNIQUE ("idempotencyKey")
      )
    `)
    await queryRunner.query(`CREATE INDEX "workspace_operation_source_phase_idx" ON "workspace_operation" ("sourceNodeId", "phase")`)
    await queryRunner.query(`CREATE INDEX "workspace_operation_placement_phase_idx" ON "workspace_operation" ("placementId", "phase")`)
    await queryRunner.query(`
      CREATE UNIQUE INDEX "workspace_operation_active_placement_unique"
      ON "workspace_operation" ("placementId")
      WHERE "phase" <> 'complete'
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "workspace_operation_active_placement_unique"`)
    await queryRunner.query(`DROP INDEX "workspace_operation_placement_phase_idx"`)
    await queryRunner.query(`DROP INDEX "workspace_operation_source_phase_idx"`)
    await queryRunner.query(`DROP TABLE "workspace_operation"`)
    await queryRunner.query(`DROP INDEX "workspace_generation_placement_state_idx"`)
    await queryRunner.query(`DROP TABLE "workspace_generation"`)
  }
}
