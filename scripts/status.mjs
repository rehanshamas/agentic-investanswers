#!/usr/bin/env node
// Summarises tasks/STATUS.md: counts per status and anything in progress.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const rows = readFileSync(join(root, "tasks/STATUS.md"), "utf8")
  .split("\n")
  .map((l) => l.split("|").map((c) => c.trim()))
  .filter((c) => /^M\d-\d+[a-z]?$/.test(c[1] ?? ""))
  .map((c) => ({ id: c[1], task: c[2], status: c[3], pr: c[4] }));
const counts = {};
for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
const done = counts.done ?? 0;
console.log(`${done}/${rows.length} done · ` + Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(" · "));
for (const r of rows.filter((r) => r.status === "in progress" || r.status === "in review")) {
  console.log(`- ${r.id} ${r.status}${r.pr ? ` (${r.pr})` : ""}: ${r.task}`);
}
