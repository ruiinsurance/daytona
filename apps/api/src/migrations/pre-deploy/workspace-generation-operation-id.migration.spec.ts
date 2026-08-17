import { describe, expect, it, vi } from 'vitest'
import { Migration1787000000002 } from './1787000000002-migration'

describe('Migration1787000000002', () => {
  it('backfills a durable generation operation id and adds a uniqueness guard', async () => {
    const query = vi.fn().mockResolvedValue(undefined)

    await new Migration1787000000002().up({ query } as any)

    const statements = query.mock.calls.map(([statement]) => String(statement)).join('\n')
    expect(statements).toContain('ADD "operationId" uuid')
    expect(statements).toContain('UPDATE "workspace_generation" SET "operationId" = uuid_generate_v4()')
    expect(statements).toContain('ALTER COLUMN "operationId" SET NOT NULL')
    expect(statements).toContain('workspace_generation_operation_unique')
    expect(statements).not.toMatch(/\b(DELETE|TRUNCATE|DROP TABLE)\b/i)
  })

  it('down removes only the operation id index and column', async () => {
    const query = vi.fn().mockResolvedValue(undefined)

    await new Migration1787000000002().down({ query } as any)

    const statements = query.mock.calls.map(([statement]) => String(statement)).join('\n')
    expect(statements).toContain('DROP INDEX "workspace_generation_operation_unique"')
    expect(statements).toContain('DROP COLUMN "operationId"')
    expect(statements).not.toContain('DROP TABLE')
  })
})
