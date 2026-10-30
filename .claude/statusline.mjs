#!/usr/bin/env node
// Status line: context used, plan usage, branch. Turns to a warning past 60% context.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const d = JSON.parse(readFileSync(0, "utf8"));
const ctx = Math.round(d.context_window?.used_percentage ?? 0);
const five = d.rate_limits?.five_hour?.used_percentage;
const week = d.rate_limits?.seven_day?.used_percentage;
let branch = "";
try {
  branch = execSync("git branch --show-current", { cwd: d.workspace?.current_dir ?? process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {}
const bar = "▓".repeat(Math.round(ctx / 10)) + "░".repeat(10 - Math.round(ctx / 10));
const color = ctx >= 75 ? "\x1b[31m" : ctx >= 60 ? "\x1b[33m" : "\x1b[32m";
const parts = [`${color}context ${bar} ${ctx}%\x1b[0m`];
if (ctx >= 60) parts.push(`${color}⚠ run /handoff, then start a fresh session\x1b[0m`);
if (five != null) parts.push(`5h ${Math.round(five)}%`);
if (week != null) parts.push(`week ${Math.round(week)}%`);
if (branch) parts.push(branch);
console.log(parts.join("  ·  "));
