import { describe, expect, it } from 'vitest';

import { SafeguardsConfigError, parseRateLimits, windowOf } from './safeguards.js';

const rule = { limit: 5, windowSeconds: 60 };
const valid = { rateLimits: { humanReads: rule, agentReads: rule, signIn: rule, signUp: rule, agentKeyChanges: rule } };

describe('windowOf', () => {
  it('gives the fixed window a time falls in and the whole seconds until the next', () => {
    expect(windowOf(120, 60)).toEqual({ start: 120, retryAfter: 60 });
    expect(windowOf(179.2, 60)).toEqual({ start: 120, retryAfter: 1 });
    expect(windowOf(150.5, 60)).toEqual({ start: 120, retryAfter: 30 });
  });
});

describe('parseRateLimits', () => {
  it('reads every limit', () => {
    expect(parseRateLimits(valid).signIn).toEqual(rule);
  });

  it.each([
    ['not an object', null],
    ['no rateLimits', {}],
    ['a missing limit', { rateLimits: { ...valid.rateLimits, signUp: undefined } }],
    ['an unknown limit', { rateLimits: { ...valid.rateLimits, uploads: rule } }],
    ['a zero limit', { rateLimits: { ...valid.rateLimits, signIn: { limit: 0, windowSeconds: 60 } } }],
    ['a fractional limit', { rateLimits: { ...valid.rateLimits, signIn: { limit: 1.5, windowSeconds: 60 } } }],
    ['a window over a day', { rateLimits: { ...valid.rateLimits, signIn: { limit: 1, windowSeconds: 86_401 } } }],
  ])('refuses %s', (_, input) => {
    expect(() => parseRateLimits(input)).toThrow(SafeguardsConfigError);
  });
});
