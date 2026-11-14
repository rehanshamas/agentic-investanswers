// The browser app reaches the platform only over HTTP and WebSocket (M1-16,
// M2-05): it may import the client contract, and nothing it depends on, even
// indirectly, is part of the data layer. The lint rule enforces this; this
// test pins it for the dependencies actually declared.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));

interface Manifest {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
  readonly nx?: { readonly tags?: readonly string[] };
}

/** Workspace packages by name, from the workspace globs (apps/*, contexts/*, shared-kernel). */
function workspace(): Map<string, Manifest> {
  const packages = new Map<string, Manifest>();
  const dirs = ['shared-kernel', ...['apps', 'contexts'].flatMap((d) => readdirSync(`${root}${d}`).map((name) => `${d}/${name}`))];
  for (const dir of dirs) {
    const path = `${root}${dir}/package.json`;
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
    packages.set(manifest.name, manifest);
  }
  return packages;
}

describe('browser boundary', () => {
  it('nothing the chart depends on, directly or not, is part of the data layer', () => {
    const packages = workspace();
    const seen = new Set<string>();
    const visit = (name: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      for (const dep of Object.keys(packages.get(name)?.dependencies ?? {})) if (packages.has(dep)) visit(dep);
    };
    visit('@aia/app-web-chart');
    const reached = [...seen].filter((name) => name !== '@aia/app-web-chart');
    expect(reached.sort()).toEqual(['@aia/client-contract', '@aia/shared-kernel']);
    for (const name of reached) expect(packages.get(name)?.nx?.tags ?? []).not.toContain('layer:data');
  });

  it('the lint rule lets the chart import the client contract', async () => {
    const eslint = new ESLint({ cwd: root });
    const [result] = await eslint.lintText("import { parseClientMessage } from '@aia/client-contract';\nexport { parseClientMessage };\n", {
      filePath: `${root}apps/web-chart/src/x.ts`,
    });
    expect((result?.messages ?? []).filter((m) => m.ruleId === '@nx/enforce-module-boundaries')).toEqual([]);
  });
});
