#!/usr/bin/env node
// Reads docs/owner-inputs.md and reports what Sham still owes.
//   node scripts/owner-inputs.mjs               list pending items (exit 0)
//   node scripts/owner-inputs.mjs --task M1-04  exit 1 if a pending item blocks that task
//   node scripts/owner-inputs.mjs --session     short summary for the SessionStart hook
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const today = process.env.AIA_TODAY ?? new Date().toISOString().slice(0, 10);

function readEnvFile() {
  const env = {};
  const file = join(root, ".env");
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

function hasFiles(dir) {
  if (!existsSync(dir)) return false;
  return readdirSync(dir, { withFileTypes: true }).some(
    (e) => e.name !== ".gitkeep" && (e.isFile() || hasFiles(join(dir, e.name))),
  );
}

// Returns null when the check passes, or a reason when it fails.
function runCheck(check, env) {
  if (!check) return null;
  const [kind, value] = check.split(":");
  if (kind === "env") return env[value] || process.env[value] ? null : `${value} is not set in .env`;
  if (kind === "dir") return hasFiles(join(root, value)) ? null : `${value}/ has no files`;
  if (kind === "nodo") {
    const file = join(root, value);
    if (!existsSync(file)) return `${value} is missing`;
    const n = (readFileSync(file, "utf8").match(/TODO\(Sham\)/g) ?? []).length;
    return n === 0 ? null : `${value} still has ${n} TODO(Sham)`;
  }
  return `unknown check ${check}`;
}

export function loadItems() {
  const text = readFileSync(join(root, "docs/owner-inputs.md"), "utf8");
  const env = readEnvFile();
  const items = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^- \[( |x|X)\] \*\*(OI-\d+)\*\* (.+)$/);
    if (!m) continue;
    const parts = m[3].split(" · ");
    const item = { id: m[2], ticked: m[1] !== " ", what: parts[0], due: null, blocks: [], check: null };
    for (const p of parts.slice(1)) {
      if (p.startsWith("due ")) item.due = p.slice(4).trim();
      else if (p.startsWith("blocks ")) item.blocks = (p.slice(7).match(/M\d-\d+[a-z]?/g) ?? []);
      else if (p.startsWith("check ")) item.check = p.slice(6).trim();
    }
    const failed = runCheck(item.check, env);
    item.problem = !item.ticked ? "not marked done" : failed;
    item.pending = item.problem !== null;
    item.overdue = item.pending && item.due !== null && item.due < today;
    items.push(item);
  }
  return items;
}

function fmt(i) {
  const flag = i.overdue ? "OVERDUE " : "";
  const blocks = i.blocks.length ? ` · blocks ${i.blocks.join(", ")}` : "";
  return `- ${flag}${i.id} ${i.what} (due ${i.due}${blocks}): ${i.problem}`;
}

const args = process.argv.slice(2);
const items = loadItems();
const pending = items.filter((i) => i.pending);

if (args[0] === "--task") {
  const task = (args[1] ?? "").toUpperCase();
  const blockers = pending.filter((i) => i.blocks.some((b) => b.toUpperCase() === task));
  if (blockers.length) {
    console.log(`BLOCKED: task ${task} needs these owner inputs first:\n${blockers.map(fmt).join("\n")}`);
    console.log("Do not start this task. Tell Sham what is missing; continue only after it is provided.");
    process.exit(1);
  }
  console.log(`Task ${task}: no owner inputs pending.`);
} else if (args[0] === "--session") {
  if (!pending.length) process.exit(0);
  const overdue = pending.filter((i) => i.overdue);
  console.log(`Owner inputs: ${pending.length} pending, ${overdue.length} overdue (docs/owner-inputs.md). Tell Sham about overdue ones before anything else.`);
  console.log((overdue.length ? overdue : pending.slice(0, 5)).map(fmt).join("\n"));
} else {
  console.log(pending.length ? pending.map(fmt).join("\n") : "Nothing pending.");
}
