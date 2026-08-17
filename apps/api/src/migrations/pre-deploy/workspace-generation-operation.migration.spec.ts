import { describe, expect, it, vi } from 'vitest'
import { Migration1787000000001 } from './1787000000001-migration'

describe('Migration1787000000001', () => {
  it('creates durable generation and operation tables without destructive statements', async () => {
    const query = vi.fn().mockResolvedValue(undefined)
    await new Migration1787000000001().up({ query } as any)
    const statements = query.mock.calls.map(([statement]) => String(statement)).join('\n')
    expect(statements).toContain('CREATE TABLE "workspace_generation"')
    expect(statements).toContain('CREATE TABLE "workspace_operation"')
    expect(statements).toContain('workspace_generation_placement_generation_unique')
    expect(statements).toContain('workspace_operation_idempotency_unique')
    expect(statements).toContain('workspace_operation_active_placement_unique')
    expect(statements).toContain('WHERE "phase" <> \'complete\'')
    expect(statements).not.toMatch(/\b(DELETE|TRUNCATE|UPDATE)\b/i)
  })

  it('down removes only the tables and indexes owned by the migration', async () => {
    const query = vi.fn().mockResolvedValue(undefined)
    await new Migration1787000000001().down({ query } as any)
    const statements = query.mock.calls.map(([statement]) => String(statement)).join('\n')
    expect(statements).toContain('DROP TABLE "workspace_operation"')
    expect(statements).toContain('DROP TABLE "workspace_generation"')
    expect(statements).not.toContain('storage_node')
  })
})
