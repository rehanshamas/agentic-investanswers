// CLAUDE.md rule 7, checked mechanically: no source file names a provider
// except that provider's adapter folder and the adapter registry. Everything
// else must get its provider from the feed plan (config/feeds.json).

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADAPTERS } from '@aia/hydration';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Providers we have had or planned, registered or not. */
const PROVIDERS = [...new Set([...Object.keys(ADAPTERS), 'coinapi'])];

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(path);
  }
  return found;
}

function allowed(file: string, provider: string): boolean {
  return file.includes(`/adapters/${provider}/`) || file.endsWith('/adapters/registry.ts');
}

describe('feed independence (CLAUDE.md rule 7)', () => {
  it('names a provider in code only inside its adapter folder and the registry', () => {
    const files = ['apps', 'contexts', 'shared-kernel'].flatMap((dir) => sources(join(ROOT, dir)));
    const offences: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments may explain history
        for (const provider of PROVIDERS) {
          if (allowed(file, provider)) continue;
          if (new RegExp(`['"\`]${provider}['"\`/]`).test(line)) {
            offences.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
          }
        }
      });
    }
    expect(offences).toEqual([]);
  });
});
