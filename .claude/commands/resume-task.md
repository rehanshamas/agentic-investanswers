---
description: Resume a task from its handoff notes
argument-hint: <task-id>
allowed-tools: Bash(node scripts/owner-inputs.mjs:*), Bash(git checkout:*), Bash(git switch:*), Bash(git status:*), Bash(git log:*)
---
Resume task **$ARGUMENTS**.

Owner-inputs gate result:
!`node scripts/owner-inputs.mjs --task $ARGUMENTS || true`

If the gate says BLOCKED, stop and tell Sham what is missing.
Otherwise switch to the task's branch, read `tasks/$ARGUMENTS.md` (especially Plan and Handoff) and `git log` on the branch, then tell Sham in 3 lines where things stand and what you'll do next. Continue once Sham agrees.
