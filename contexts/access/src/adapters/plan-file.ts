// Load the plan book (config/plans.json; M2-09, decision record T-02).
// AIA_PLANS points at another file, for staging or a test.

import { readFileSync } from 'node:fs';

import type { PlanBook } from '../domain/plans.js';
import { PlanConfigError, parsePlanBook } from '../domain/plans.js';

const DEFAULT_PLANS = new URL('../../../../config/plans.json', import.meta.url);

type Env = Readonly<Record<string, string | undefined>>;

export function loadPlanBook(env: Env = process.env): PlanBook {
  const path = env['AIA_PLANS'] ?? DEFAULT_PLANS;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new PlanConfigError(`Could not read the plans config at ${String(path)}: ${String(error)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new PlanConfigError(`The plans config at ${String(path)} is not valid JSON: ${String(error)}`);
  }
  try {
    return parsePlanBook(json);
  } catch (error) {
    if (error instanceof PlanConfigError) throw new PlanConfigError(`${String(path)}: ${error.message}`);
    throw error;
  }
}
