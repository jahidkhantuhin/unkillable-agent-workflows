import { describe, it, expect } from 'vitest';
import { schedule, settingsSchema, kinds, percentile } from './config';
import { check, type Evidence } from './check';
describe('seeded chaos schedule and invariant gate', () => {
  it('reproduces a seeded schedule, covers every enabled scenario and validates rates', () => {
    const settings = settingsSchema.parse({ runs: 50, seed: 42 });
    const a = schedule(settings);
    expect(schedule(settings)).toEqual(a);
    expect(new Set(a.map((p) => p.kind))).toEqual(new Set(kinds));
    expect(schedule({ ...settings, seed: 43 })).not.toEqual(a);
    expect(() => settingsSchema.parse({ rates: { normal: 1 } })).toThrow();
  });
  it('uses nearest-rank percentiles and reports no samples honestly', () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([9, 1, 5, 3], 0.5)).toBe(3);
    expect(percentile([9, 1, 5, 3], 0.95)).toBe(9);
  });
  it('hard-fails duplicates, nonterminal work and inconsistent compensation', () => {
    const evidence: Evidence = {
      plan: { index: 0, kind: 'normal', delayMs: 20 },
      run: { id: 'run', status: 'succeeded', updatedAt: new Date(), state: {} },
      refunds: [{ status: 'active' }],
      emails: [{ purpose: 'reply', status: 'sent' }],
      outbox: [{ status: 'sent' }],
      receipts: [{ key: 'stable', status: 'completed' }],
      deliveries: [{}],
      ticket: { status: 'closed' },
      captures: 1,
      events: [],
    };
    expect(check(evidence, Date.now(), 10000)).toEqual([]);
    expect(
      check({ ...evidence, refunds: [{}, {}], captures: 2 }, Date.now(), 10000),
    ).toContain('duplicate refund');
    expect(check({ ...evidence, captures: 2 }, Date.now(), 10000)).toContain(
      'duplicate Mailpit capture',
    );
    expect(
      check(
        {
          ...evidence,
          emails: [
            { purpose: 'reply', status: 'sent' },
            { purpose: 'reply', status: 'sent' },
          ],
        },
        Date.now(),
        10000,
      ),
    ).toContain('duplicate reply email');
    expect(check({ ...evidence, run: undefined }, Date.now(), 10000)).toEqual([
      'missing run',
    ]);
    expect(
      check(
        {
          ...evidence,
          run: { status: 'running', updatedAt: new Date(0), state: {} },
        },
        20000,
        10000,
      ),
    ).toContain('running past timeout');
    expect(
      check(
        { ...evidence, plan: { ...evidence.plan, kind: 'permanent' } },
        Date.now(),
        10000,
      ),
    ).toContain('compensation order/progress inconsistent');
  });
});
