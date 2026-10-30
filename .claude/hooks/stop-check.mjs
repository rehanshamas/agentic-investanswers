#!/usr/bin/env node
// Stop: if code changed in this working tree, run lint/test/typecheck for affected projects
// and keep Claude working until they pass. Runs at most once per stop cycle.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const input = JSON.parse(readFileSync(0, "utf8"));
if (input.stop_hook_active) process.exit(0);

const sh = (cmd) => execSync(cmd, { cwd: input.cwd ?? process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let changed = "";
try {
  changed = sh("git status --porcelain -- '*.ts' '*.tsx' '*.mjs' '*.json' 'eslint.config.mjs'").trim();
} catch {
  process.exit(0);
}
if (!changed) process.exit(0);

try {
  let base = "main";
  try {
    sh("git rev-parse --verify origin/main");
    base = "origin/main";
  } catch {}
  sh(`pnpm -s nx affected -t lint test typecheck --base=${base} --output-style=static`);
} catch (e) {
  const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.split("\n").slice(-40).join("\n");
  console.error(`pnpm check failed on your uncommitted changes. Fix it before stopping (never by weakening tests or lint rules):\n${out}`);
  process.exit(2);
}
