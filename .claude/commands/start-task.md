---
description: Start a backlog task (checks owner inputs first)
argument-hint: <task-id, e.g. M1-06>
allowed-tools: Bash(node scripts/owner-inputs.mjs:*), Bash(git checkout:*), Bash(git switch:*), Bash(git fetch:*)
---
Start task **$ARGUMENTS**.

Owner-inputs gate result:
!`node scripts/owner-inputs.mjs --task $ARGUMENTS || true`

1. If the gate says BLOCKED: stop here. Tell Sham exactly which inputs are missing and how to provide them. Do not create files, branches or plans for this task.
2. Check its dependencies (the → column in `docs/backlog.md`) are `done` in `tasks/STATUS.md`. If one isn't, stop and say which.
3. Fetch `origin/main` and create branch `$ARGUMENTS-<short-slug>` from it.
4. Create `tasks/$ARGUMENTS.md` from `tasks/_template.md`, filled from the backlog row. Find the task's GitHub issue number (title starts with `$ARGUMENTS`) and put it in the card.
5. Set the task to `in progress` in `tasks/STATUS.md`.
6. Read the context files the card lists, write the plan into the card, and show it to Sham. **Do not edit code until Sham approves the plan.**
