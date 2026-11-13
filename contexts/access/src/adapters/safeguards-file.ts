// Load the rate limits (config/safeguards.json; M2-10).
// AIA_SAFEGUARDS points at another file, for staging or a test.

import { readFileSync } from 'node:fs';

import type { RateLimits } from '../domain/safeguards.js';
import { SafeguardsConfigError, parseRateLimits } from '../domain/safeguards.js';

const DEFAULT_FILE = new URL('../../../../config/safeguards.json', import.meta.url);

type Env = Readonly<Record<string, string | undefined>>;

export function loadRateLimits(env: Env = process.env): RateLimits {
  const path = env['AIA_SAFEGUARDS'] ?? DEFAULT_FILE;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new SafeguardsConfigError(`Could not read the safeguards config at ${String(path)}: ${String(error)}`);
  }
  try {
    return parseRateLimits(json);
  } catch (error) {
    if (error instanceof SafeguardsConfigError) throw new SafeguardsConfigError(`${String(path)}: ${error.message}`);
    throw error;
  }
}
