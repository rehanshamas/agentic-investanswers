// Placeholder subscription plans (M2-09; decision record T-02). Plans are data
// (config/plans.json): which instruments and timeframes each includes, the
// plan a new account starts on, which accounts are on which plan, and where
// to send someone to upgrade. Changing any of it is a configuration change.
// Billing is InvestAnswers' (OI-21); linking to it later is a new adapter.
// Pure.

import type { Timeframe } from '@aia/shared-kernel';
import { isTimeframe } from '@aia/shared-kernel';

import { isValidEmail, normaliseEmail } from './account.js';

/** 'all' includes every instrument (or timeframe), present and future. */
export type Includes<T> = 'all' | readonly T[];

export interface Plan {
  readonly id: string;
  readonly name: string;
  readonly instruments: Includes<string>;
  readonly timeframes: Includes<Timeframe>;
}

export interface PlanBook {
  readonly plans: readonly Plan[];
  /** The plan of every account not listed in `assignments` (an agent has its owner's plan). */
  readonly defaultPlan: string;
  /** Normalised email -> plan id. A placeholder until InvestAnswers billing says who pays for what. */
  readonly assignments: ReadonlyMap<string, string>;
  /** Shown with every refusal, so locked content always offers a way in. */
  readonly upgradeUrl: string;
}

export class PlanConfigError extends Error {}

const PLAN_ID = /^[a-z][a-z0-9-]{0,31}$/;

export function planIncludes(plan: Plan, symbol: string, timeframe: Timeframe): boolean {
  const has = <T>(includes: Includes<T>, value: T) => includes === 'all' || includes.includes(value);
  return has(plan.instruments, symbol) && has(plan.timeframes, timeframe);
}

/** The plan for an account's email, or the default plan when there is none or it is not assigned. */
export function planFor(book: PlanBook, email: string | undefined): Plan {
  const id = (email === undefined ? undefined : book.assignments.get(normaliseEmail(email))) ?? book.defaultPlan;
  return book.plans.find((plan) => plan.id === id) as Plan;
}

/** Check a plan book read from JSON; every problem is named, so a bad edit fails at start-up. */
export function parsePlanBook(input: unknown): PlanBook {
  const fail = (message: string): never => {
    throw new PlanConfigError(message);
  };
  if (!isRecord(input)) return fail('The plans config must be an object');

  const upgradeUrl = input['upgradeUrl'];
  if (typeof upgradeUrl !== 'string' || !/^https:\/\/\S+$/.test(upgradeUrl)) fail('upgradeUrl must be an https URL');

  const rawPlans = input['plans'];
  if (!Array.isArray(rawPlans) || rawPlans.length === 0) return fail('plans must be a non-empty list');
  const plans = rawPlans.map((raw: unknown, index): Plan => {
    if (!isRecord(raw)) return fail(`plans[${index}] must be an object`);
    const { id, name } = raw;
    if (typeof id !== 'string' || !PLAN_ID.test(id)) {
      return fail(`plans[${index}].id must be lower case letters, digits or dashes, starting with a letter`);
    }
    if (typeof name !== 'string' || name.trim() === '') return fail(`plan "${id}" needs a name`);
    const instruments = includesOf<string>(raw['instruments'], `plan "${id}" instruments`, (value) => /^[A-Z0-9.]{1,16}$/.test(value), fail);
    const timeframes = includesOf<Timeframe>(raw['timeframes'], `plan "${id}" timeframes`, isTimeframe, fail);
    return { id, name, instruments, timeframes };
  });
  const ids = new Set<string>();
  for (const { id } of plans) {
    if (ids.has(id)) fail(`plan "${id}" is listed twice`);
    ids.add(id);
  }

  const defaultPlan = input['defaultPlan'];
  if (typeof defaultPlan !== 'string' || !ids.has(defaultPlan)) fail(`defaultPlan must be one of: ${[...ids].join(', ')}`);

  const rawAssignments = input['assignments'] ?? {};
  if (!isRecord(rawAssignments)) return fail('assignments must be an object of email -> plan id');
  const assignments = new Map<string, string>();
  for (const [rawEmail, planId] of Object.entries(rawAssignments)) {
    const email = normaliseEmail(rawEmail);
    if (!isValidEmail(email)) fail(`assignments: "${rawEmail}" is not an email`);
    if (typeof planId !== 'string' || !ids.has(planId)) fail(`assignments: "${rawEmail}" names an unknown plan`);
    if (assignments.has(email)) fail(`assignments: "${rawEmail}" is listed twice`);
    assignments.set(email, planId as string);
  }

  return { plans, defaultPlan: defaultPlan as string, assignments, upgradeUrl: upgradeUrl as string };
}

function includesOf<T extends string>(
  value: unknown,
  what: string,
  valid: (value: string) => boolean,
  fail: (message: string) => never,
): Includes<T> {
  if (value === 'all') return 'all';
  if (!Array.isArray(value)) return fail(`${what} must be "all" or a list`);
  for (const item of value) {
    if (typeof item !== 'string' || !valid(item)) fail(`${what}: ${JSON.stringify(item)} is not valid`);
  }
  if (new Set(value).size !== value.length) fail(`${what} lists a value twice`);
  return value as T[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
