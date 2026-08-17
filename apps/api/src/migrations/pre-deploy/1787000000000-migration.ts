import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1787000000000 implements MigrationInterface {
  name = 'Migration1787000000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."storage_node_state_enum" AS ENUM('joining', 'active', 'cordoned', 'draining', 'drained', 'offline', 'removed')`,
    )
    await queryRunner.query(`
      CREATE TABLE "storage_node" (
        "nodeId" uuid NOT NULL,
        "runnerId" uuid NOT NULL,
        "state" "public"."storage_node_state_enum" NOT NULL DEFAULT 'joining',
        "capacityBytes" bigint NOT NULL DEFAULT '0',
        "usedBytes" bigint NOT NULL DEFAULT '0',
        "capacityInodes" bigint NOT NULL DEFAULT '0',
        "usedInodes" bigint NOT NULL DEFAULT '0',
        "labels" jsonb NOT NULL DEFAULT '{}',
        "heartbeatAt" TIMESTAMP WITH TIME ZONE,
        "removedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "storage_node_pk" PRIMARY KEY ("nodeId"),
        CONSTRAINT "storage_node_runner_unique" UNIQUE ("runnerId")
      )
    `)
    await queryRunner.query(`CREATE INDEX "storage_node_state_heartbeat_idx" ON "storage_node" ("state", "heartbeatAt")`)
    await queryRunner.query(`
      CREATE TABLE "workspace_placement" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "volumeId" character varying NOT NULL,
        "subpath" character varying NOT NULL,
        "sandboxId" uuid NOT NULL,
        "ownerNodeId" uuid,
        "localGeneration" bigint NOT NULL DEFAULT '0',
        "cosGeneration" bigint NOT NULL DEFAULT '0',
        "fenceEpoch" bigint NOT NULL DEFAULT '1',
        "leaseOwner" text,
        "leaseExpiresAt" TIMESTAMP WITH TIME ZONE,
        "replicationStatus" character varying(32) NOT NULL DEFAULT 'pending',
        "dirty" boolean NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "workspace_placement_pk" PRIMARY KEY ("id"),
        CONSTRAINT "workspace_placement_volume_subpath_unique" UNIQUE ("volumeId", "subpath"),
        CONSTRAINT "workspace_placement_sandbox_unique" UNIQUE ("sandboxId")
      )
    `)
    await queryRunner.query(`CREATE INDEX "workspace_placement_owner_fence_idx" ON "workspace_placement" ("ownerNodeId", "fenceEpoch")`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "workspace_placement_owner_fence_idx"`)
    await queryRunner.query(`DROP TABLE "workspace_placement"`)
    await queryRunner.query(`DROP INDEX "storage_node_state_heartbeat_idx"`)
    await queryRunner.query(`DROP TABLE "storage_node"`)
    await queryRunner.query(`DROP TYPE "public"."storage_node_state_enum"`)
  }
}
