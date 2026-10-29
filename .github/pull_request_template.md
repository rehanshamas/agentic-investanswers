## Task
Closes #<issue> · Task card: `tasks/<ID>.md`

## What changed

## How it was verified
<!-- Commands run and their results: pnpm check, pnpm parity, pnpm rebuild-check, ... -->

## By-hand checklist
Claude ticks what it verified. Sham checks every box before merging.
- [ ] No test, tolerance or fixture changed (or the task explicitly asked for it; reason here)
- [ ] Bar rules respected (sessions, UTC, week start); 3 bars spot-checked against TradingView: <which bars>
- [ ] Raw data never overwritten; cooked data derived from raw only
- [ ] Plan check on every new route or WebSocket subscription
- [ ] No indicator internals in API responses, WebSocket messages or browser code
- [ ] No secrets or `.env`; no new AWS service or dependency without approval

## For Sham to check by hand
<!-- Specific things only a human can confirm for this PR -->

## Handoff
<!-- Anything left for a follow-up task -->
