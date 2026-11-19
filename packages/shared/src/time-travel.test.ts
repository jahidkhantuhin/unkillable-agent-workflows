import { describe, it, expect } from 'vitest';
import { diffStates, checkpointIdSchema } from './time-travel';
describe('checkpoint state diff', () => {
  it('accepts native step-encoded checkpoint IDs and refuses malformed cursors', () => {
    expect(
      checkpointIdSchema.safeParse('1f1e201b-da9c-62e0-ffff-083a9ce17971')
        .success,
    ).toBe(true);
    expect(checkpointIdSchema.safeParse('../other-thread').success).toBe(false);
    expect(
      checkpointIdSchema.safeParse('1f1e201b-da9c-62e0-ffff-083a9ce17971-extra')
        .success,
    ).toBe(false);
  });
  it('reports nested edits, additions and removals with JSON pointer escaping', () => {
    const a = { nested: { count: 1 }, gone: null, 'a/b~c': 'old' };
    const b = { nested: { count: 2 }, added: null, 'a/b~c': 'new' };
    expect(diffStates(a, b)).toEqual([
      { path: '/a~1b~0c', kind: 'changed', before: 'old', after: 'new' },
      { path: '/added', kind: 'added', after: null },
      { path: '/gone', kind: 'removed', before: null },
      { path: '/nested/count', kind: 'changed', before: 1, after: 2 },
    ]);
    expect(a.nested.count).toBe(1);
  });
  it('compares object keys without ordering and treats changed arrays as one value', () => {
    expect(
      diffStates({ a: [{ x: 1, y: 2 }] }, { a: [{ y: 2, x: 1 }] }),
    ).toEqual([]);
    expect(diffStates({ completed: ['a'] }, { completed: ['a', 'b'] })).toEqual(
      [
        {
          path: '/completed',
          kind: 'changed',
          before: ['a'],
          after: ['a', 'b'],
        },
      ],
    );
  });
  it('distinguishes missing values, null, and type changes at the root', () => {
    expect(diffStates(null, {})).toEqual([
      { path: '', kind: 'changed', before: null, after: {} },
    ]);
    expect(diffStates({ x: null }, {})).toEqual([
      { path: '/x', kind: 'removed', before: null },
    ]);
    expect(diffStates({ x: null }, { x: '' })).toHaveLength(1);
    expect(diffStates({}, {})).toEqual([]);
  });
});
