// M1-16 done-check: the lint rule (eslint.config.mjs) refuses any import of
// storage, cache or hydration code outside the data layer, and keeps the
// browser app away from the data layer altogether. Lints in-memory text as if
// it sat in each project, with the repository's real ESLint configuration.

import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function boundaryErrors(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${root}${file}` });
  return (result?.messages ?? []).filter((m) => m.ruleId === '@nx/enforce-module-boundaries').map((m) => m.message);
}

describe('data layer boundary (lint)', () => {
  it.each([
    ['apps/platform/src/x.ts', "import { S3RawBarStore } from '@aia/hydration';"],
    ['apps/platform/src/x.ts', "import { RedisRecentBarsCache } from '@aia/market-data';"],
    ['contexts/indicators/src/x.ts', "import { RecentBars } from '@aia/market-data';"],
    ['contexts/serving/src/x.ts', "import { CookedReader } from '@aia/market-data';"],
    ['contexts/backtesting/src/x.ts', "import { RawMinuteSource } from '@aia/hydration';"],
  ])('refuses %s importing data internals: %s', async (file, line) => {
    expect(await boundaryErrors(file, `${line}\nexport {};\n`)).toEqual([expect.stringContaining('can only depend on libs tagged with')]);
  });

  it.each([
    ["import { openLocalDataLayer } from '@aia/data';"],
    ["import { HistoryQuery } from '@aia/serving';"],
  ])('keeps the browser app away from the data layer: %s', async (line) => {
    expect(await boundaryErrors('apps/web-chart/src/x.ts', `${line}\nexport {};\n`)).toEqual([expect.stringContaining('runtime:browser')]);
  });

  it.each([
    ['apps/platform/src/x.ts', "import { openLocalDataLayer } from '@aia/data';"],
    ['contexts/indicators/src/x.ts', "import type { DataAccess } from '@aia/data';"],
    ['apps/hydration/src/x.ts', "import { RecentBars } from '@aia/market-data';"],
  ])('allows the front door, and the data layer its own internals: %s', async (file, line) => {
    expect(await boundaryErrors(file, `${line}\nexport {};\n`)).toEqual([]);
  });
});
