import { describe, expect, it } from 'vitest';

import { SafeguardsConfigError } from '../domain/safeguards.js';
import { loadRateLimits } from './safeguards-file.js';

describe('loadRateLimits', () => {
  it('reads the checked-in config/safeguards.json', () => {
    expect(loadRateLimits({}).humanReads.limit).toBeGreaterThan(0);
  });

  it('names the file when it cannot be read', () => {
    expect(() => loadRateLimits({ AIA_SAFEGUARDS: '/nowhere/safeguards.json' })).toThrow(SafeguardsConfigError);
    expect(() => loadRateLimits({ AIA_SAFEGUARDS: '/nowhere/safeguards.json' })).toThrow('/nowhere/safeguards.json');
  });
});
