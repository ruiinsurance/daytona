/* Copyright Daytona Platforms Inc. SPDX-License-Identifier: AGPL-3.0 */
import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1794895200000 implements MigrationInterface {
  name = 'Migration1794895200000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS sandbox_workspace_recovery_metadata (
      "sandboxId" uuid PRIMARY KEY, "organizationId" uuid NOT NULL,
      "schemaVersion" integer NOT NULL DEFAULT 1, metadata jsonb NOT NULL,
      "providerUpdatedAt" timestamptz NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT workspace_recovery_metadata_identity CHECK (
        jsonb_typeof(metadata)='object' AND metadata ?& ARRAY['id','organizationId','storageBackend','state','desiredState','pending']
        AND metadata->>'id'="sandboxId"::text AND metadata->>'organizationId'="organizationId"::text
        AND metadata->>'storageBackend'='local'
        AND metadata->>'state'='destroyed' AND metadata->>'desiredState'='destroyed'
        AND metadata->'pending'='false'::jsonb)
    )`)
    await queryRunner.query('CREATE INDEX IF NOT EXISTS workspace_recovery_metadata_org ON sandbox_workspace_recovery_metadata ("organizationId")')
    await queryRunner.query('REVOKE ALL ON sandbox_workspace_recovery_metadata FROM PUBLIC')
    // Capture rows that still exist before the old API's next cleanup tick.
    await queryRunner.query(`INSERT INTO sandbox_workspace_recovery_metadata
      ("sandboxId","organizationId",metadata,"providerUpdatedAt")
      SELECT s.id,s."organizationId",to_jsonb(s),s."updatedAt" FROM sandbox s
      WHERE s.state='destroyed' AND s."desiredState"='destroyed' AND s.pending=false
        AND s."storageBackend"='local' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.volumes)='array' THEN s.volumes ELSE '[]'::jsonb END) v
          WHERE v->>'mountPath'='/workspace' AND v->>'subpath'='sandboxes/'||s.id::text||'/workspace')
      ON CONFLICT ("sandboxId") DO NOTHING`)
  }

  async down(): Promise<void> {
    // A rollback must not erase the only copy for already-cleaned sandboxes.
    // Old API versions ignore this table. Remove it only after a separate,
    // explicit recovery-lineage retention review.
  }
}
