import { describe, expect, it } from 'vitest';

import { PlanConfigError, parsePlanBook, planFor, planIncludes } from './plans.js';

const config = {
  upgradeUrl: 'https://example.com/upgrade',
  defaultPlan: 'free',
  plans: [
    { id: 'free', name: 'Free', instruments: ['BTCUSD'], timeframes: ['1h', '1D'] },
    { id: 'pro', name: 'Pro', instruments: 'all', timeframes: 'all' },
  ],
  assignments: { ' Pat@Example.com ': 'pro' },
};

describe('plans', () => {
  const book = parsePlanBook(config);

  it('a plan includes only its instruments and timeframes; "all" includes everything', () => {
    const [free, pro] = book.plans;
    expect(planIncludes(free!, 'BTCUSD', '1h')).toBe(true);
    expect(planIncludes(free!, 'BTCUSD', '5m')).toBe(false);
    expect(planIncludes(free!, 'NVDA', '1h')).toBe(false);
    expect(planIncludes(pro!, 'NEWSYMBOL', '1m')).toBe(true);
  });

  it('an assigned email (normalised) gets its plan; anyone else, or nobody, the default', () => {
    expect(planFor(book, 'pat@example.com').id).toBe('pro');
    expect(planFor(book, 'PAT@EXAMPLE.COM').id).toBe('pro');
    expect(planFor(book, 'sam@example.com').id).toBe('free');
    expect(planFor(book, undefined).id).toBe('free');
  });

  it('assignments may be left out', () => {
    const { upgradeUrl, defaultPlan, plans } = config;
    expect(parsePlanBook({ upgradeUrl, defaultPlan, plans }).assignments.size).toBe(0);
  });

  it.each([
    ['not an object', []],
    ['an http upgrade URL', { ...config, upgradeUrl: 'http://example.com' }],
    ['no plans', { ...config, plans: [] }],
    ['a bad plan id', { ...config, plans: [{ ...config.plans[0], id: 'Free Plan' }] }],
    ['a plan without a name', { ...config, plans: [{ ...config.plans[0], name: ' ' }] }],
    ['an unknown timeframe', { ...config, plans: [{ ...config.plans[0], timeframes: ['2h'] }] }],
    ['"interval" style 1min', { ...config, plans: [{ ...config.plans[0], timeframes: ['1min'] }] }],
    ['a lower case symbol', { ...config, plans: [{ ...config.plans[0], instruments: ['btcusd'] }] }],
    ['instruments neither "all" nor a list', { ...config, plans: [{ ...config.plans[0], instruments: 'some' }] }],
    ['a value listed twice', { ...config, plans: [{ ...config.plans[0], timeframes: ['1h', '1h'] }] }],
    ['a plan listed twice', { ...config, plans: [config.plans[0], config.plans[0]] }],
    ['an unknown default plan', { ...config, defaultPlan: 'gold' }],
    ['an assignment to an unknown plan', { ...config, assignments: { 'a@example.com': 'gold' } }],
    ['an assignment that is not an email', { ...config, assignments: { 'not-an-email': 'pro' } }],
    ['an email assigned twice', { ...config, assignments: { 'a@example.com': 'pro', 'A@example.com': 'free' } }],
  ])('refuses %s', (_, input) => {
    expect(() => parsePlanBook(input)).toThrow(PlanConfigError);
  });
});
