---
description: Write handoff notes so a fresh session can continue
allowed-tools: Bash(git add:*), Bash(git commit:*), Bash(git status:*), Bash(git diff:*)
---
Write the handoff for the current task, finished or not:

1. In `tasks/<ID>.md`, replace the Handoff section with: **Done** (what works, with the commands that prove it), **Left** (remaining steps, in order), **Surprises** (anything unexpected: data quirks, rule questions, decisions made), **Next step** (the exact first thing the next session should do).
2. Update the task's row in `tasks/STATUS.md` (`in progress`, `in review` with the PR link, or `blocked` with the reason).
3. Commit both on the task branch.
4. Tell Sham in 2 lines: where the task stands, and "start a fresh session and run `/resume-task <ID>`" if work is left.
