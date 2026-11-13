import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PlanConfigError } from '../domain/plans.js';
import { loadPlanBook } from './plan-file.js';

describe('loadPlanBook', () => {
  it('reads the checked-in config/plans.json', () => {
    const book = loadPlanBook({});
    expect(book.plans.map((plan) => plan.id)).toContain(book.defaultPlan);
  });

  it('reads AIA_PLANS instead, and names the file when it is wrong', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aia-plans-'));
    const bad = join(dir, 'plans.json');
    writeFileSync(bad, JSON.stringify({ upgradeUrl: 'https://example.com', defaultPlan: 'x', plans: [] }));
    expect(() => loadPlanBook({ AIA_PLANS: bad })).toThrow(PlanConfigError);
    expect(() => loadPlanBook({ AIA_PLANS: bad })).toThrow(bad);
    expect(() => loadPlanBook({ AIA_PLANS: join(dir, 'missing.json') })).toThrow(/Could not read/);
    writeFileSync(bad, '{');
    expect(() => loadPlanBook({ AIA_PLANS: bad })).toThrow(/not valid JSON/);
  });
});
