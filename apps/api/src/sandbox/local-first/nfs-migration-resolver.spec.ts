import { describe, expect, it } from 'vitest'
import { resolveNfsMigrationMount } from './nfs-migration-resolver'

describe('NFS migration resolver', () => {
  it('builds a hard TCP read-only plan without shell interpolation', () => {
    const plan = resolveNfsMigrationMount({
      mode: 'migration',
      server: 'nfs.test.internal',
      exportPath: '/exports/local-first',
      targetPath: '/srv/kortix-storage/migration/operation-1',
    })
    expect(plan.mountArgs).toEqual([
      'mount', '-t', 'nfs', '-o', 'ro,hard,proto=tcp,timeo=600,retrans=2',
      'nfs.test.internal:/exports/local-first', '/srv/kortix-storage/migration/operation-1',
    ])
    expect(plan.unmountArgs).toEqual(['umount', '--', '/srv/kortix-storage/migration/operation-1'])
    expect(plan.mountArgs.join(' ')).not.toContain(';')
  })

  it.each([
    { mode: 'online', server: 'nfs.test.internal', exportPath: '/exports', targetPath: '/target' },
    { mode: 'migration', server: 'nfs.test.internal', exportPath: '/../exports', targetPath: '/target' },
    { mode: 'migration', server: 'nfs.test.internal', exportPath: '/exports', targetPath: '/target/../escape' },
  ])('rejects unsafe NFS input %p', (input) => {
    expect(() => resolveNfsMigrationMount(input as any)).toThrow()
  })
})
