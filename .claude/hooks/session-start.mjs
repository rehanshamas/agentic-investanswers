#!/usr/bin/env node
// SessionStart: shows Claude (and through it, Sham) pending owner inputs and task status.
import { execFileSync } from "node:child_process";

const run = (script, args = []) => {
  try {
    return execFileSync("node", [script, ...args], { encoding: "utf8" }).trim();
  } catch (e) {
    return (e.stdout ?? "").toString().trim();
  }
};
const dir = process.env.CLAUDE_PROJECT_DIR ?? ".";
const inputs = run(`${dir}/scripts/owner-inputs.mjs`, ["--session"]);
const status = run(`${dir}/scripts/status.mjs`);
const text = [
  "Project status (from tasks/STATUS.md):",
  status,
  inputs || "Owner inputs: nothing pending.",
  inputs ? "In your first reply, list overdue owner inputs for Sham, then anything due in the next 2 days." : "",
].filter(Boolean).join("\n");
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
