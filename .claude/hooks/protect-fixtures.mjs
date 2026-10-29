#!/usr/bin/env node
// PreToolUse: blocks edits under fixtures/ (parity fixtures are the spec).
// Sham allows a fixtures task by starting Claude with AIA_ALLOW_FIXTURES=1.
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8"));
if (process.env.AIA_ALLOW_FIXTURES === "1") process.exit(0);

const ti = input.tool_input ?? {};
const touchesFixtures = (p) => typeof p === "string" && /(^|[\/\\])fixtures[\/\\]/.test(p);
let blocked = false;
if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(input.tool_name)) {
  blocked = touchesFixtures(ti.file_path ?? ti.notebook_path);
} else if (input.tool_name === "Bash") {
  const cmd = String(ti.command ?? "");
  // Writes, moves or deletes that name a fixtures path.
  blocked = /fixtures[\/\\]/.test(cmd) && /(>|\btee\b|\brm\b|\bmv\b|\bcp\b|sed\s+-i|\btruncate\b|git\s+(checkout|restore|rm)\b)/.test(cmd);
}
if (blocked) {
  console.error("Blocked: fixtures/ is protected (parity fixtures are the spec). If you believe a fixture is wrong, stop and explain why to Sham. Sham can allow a fixtures task by starting Claude with AIA_ALLOW_FIXTURES=1.");
  process.exit(2);
}
