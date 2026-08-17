import { describe, expect, it, vi } from 'vitest'
import { Migration1787000000000 } from './1787000000000-migration'

describe('Migration1787000000000', () => {
  it('is additive and does not touch existing workspace or runner rows', async () => {
    const query = vi.fn().mockResolvedValue(undefined)
    const migration = new Migration1787000000000()

    await migration.up({ query } as any)

    const statements = query.mock.calls.map(([statement]) => String(statement))
    expect(statements.join('\n')).toContain('CREATE TABLE "storage_node"')
    expect(statements.join('\n')).toContain('CREATE TABLE "workspace_placement"')
    expect(statements.join('\n')).toContain("CREATE TYPE \"public\".\"storage_node_state_enum\"")
    expect(statements.some((statement) => /\b(DELETE|TRUNCATE|UPDATE)\b/i.test(statement))).toBe(false)
    expect(statements.some((statement) => /DROP TABLE|DROP TYPE|DROP INDEX/i.test(statement))).toBe(false)
  })

  it('down only removes the objects owned by this migration', async () => {
    const query = vi.fn().mockResolvedValue(undefined)
    const migration = new Migration1787000000000()

    await migration.down({ query } as any)

    const statements = query.mock.calls.map(([statement]) => String(statement)).join('\n')
    expect(statements).toContain('DROP TABLE "workspace_placement"')
    expect(statements).toContain('DROP TABLE "storage_node"')
    expect(statements).not.toMatch(/sandbox|runner[^_]/i)
  })
})
