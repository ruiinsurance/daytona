import { rebuildOperationView } from './sandbox-rebuild-operation.view'
const identity = { sandboxId: 'sandbox', operationId: 'operation', targetSnapshot: 'target' }
describe('read-only rebuild operation view', () => {
  test('exposes no secret-bearing or internal fields', () => {
    const result = {
      ...identity,
      outcome: 'rebuild_failed_previous_restored',
      previousSnapshot: 'previous',
      ownerRunnerId: 'owner',
      environment: 'secret',
    }
    expect(
      rebuildOperationView({ ...identity, status: 'complete', result, token: 'secret' }, 'sandbox', 'operation'),
    ).toEqual({
      ...identity,
      status: 'complete',
      result: { ...identity, outcome: result.outcome, previousSnapshot: 'previous', ownerRunnerId: 'owner' },
    })
  })
  test('running evidence cannot be promoted to a terminal success', () => {
    expect(
      rebuildOperationView({ ...identity, status: 'running', result: { outcome: 'rebuilt' } }, 'sandbox', 'operation'),
    ).toEqual({ ...identity, status: 'running' })
  })
  test('rejects foreign operation, unknown outcomes and incomplete terminal proof', () => {
    for (const result of [
      null,
      { ...identity, outcome: 'operation_outcome_unknown' },
      { ...identity, outcome: 'rebuilt' },
    ]) {
      expect(() => rebuildOperationView({ ...identity, status: 'complete', result }, 'sandbox', 'operation')).toThrow()
    }
    expect(() =>
      rebuildOperationView({ ...identity, operationId: 'foreign', status: 'running' }, 'sandbox', 'operation'),
    ).toThrow()
  })
})
