// `pnpm load-live`: load test the live gateway locally (M2-04 done-check).
//
//   pnpm load-live                         1,000 clients, 60 s, memory bus, clients in 4 child processes
//   pnpm load-live --clients 2000 --seconds 120 --speed 10
//   pnpm load-live --redis                 through the local Redis (docker compose up -d), as deployed
//   pnpm load-live --redis redis://host:6379
//
// Prints what was published and received, how old values were on arrival,
// and every order or loss failure. Exits 1 on any failure, 2 on bad usage.

import { parseArgs } from 'node:util';

import { runLoad } from './load-live-harness.js';

const USAGE = 'Usage: pnpm load-live [--clients N] [--seconds S] [--speed X] [--processes P] [--redis [URL]]';

function number(text: string | undefined, fallback: number, name: string): number {
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`--${name} must be a positive number\n${USAGE}`);
    process.exit(2);
  }
  return value;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    clients: { type: 'string' },
    seconds: { type: 'string' },
    speed: { type: 'string' },
    processes: { type: 'string' },
    redis: { type: 'boolean' },
  },
});
const redisUrl = values.redis === true ? (positionals[0] ?? process.env['AIA_REDIS_URL'] ?? 'redis://127.0.0.1:6379') : undefined;

const report = await runLoad({
  clients: Math.round(number(values.clients, 1_000, 'clients')),
  seconds: number(values.seconds, 60, 'seconds'),
  speed: number(values.speed, 5, 'speed'),
  processes: Math.round(number(values.processes, 4, 'processes')),
  redis: redisUrl,
  log: (line) => console.log(line),
}).catch((error: unknown) => {
  console.error(`${error instanceof Error ? error.message : String(error)}${redisUrl === undefined ? '' : '\nIs Redis up? Run: docker compose up -d'}`);
  process.exit(2);
});

const n = (value: number) => value.toLocaleString('en-GB');
console.log(
  [
    '',
    `Bus:            ${report.bus}`,
    `Clients:        ${n(report.clients)} (${n(report.subscriptions)} subscriptions)`,
    `Published:      ${n(report.published)} updates in ${n(report.announcements)} announcements over ${report.seconds} s`,
    `Received:       ${n(report.updates)} updates in ${n(report.messages)} messages (${n(Math.round(report.messages / report.seconds))} messages/s)`,
    `Age on arrival: p50 ${report.percentiles.p50} ms, p95 ${report.percentiles.p95} ms, p99 ${report.percentiles.p99} ms, max ${report.percentiles.max} ms`,
    '                (how long after publishing each value reached a client, counted the first time the client saw it;',
    '                a value replaced by a newer one within the same 100 ms batch is never sent, so it is not counted)',
    `Order and loss: ${report.failures === 0 ? 'every client got every update of its pairs, in order, and nothing else' : `${n(report.failures)} FAILURES`}`,
    ...report.examples.map((e) => `  ${e}`),
  ].join('\n'),
);
process.exit(report.failures === 0 ? 0 : 1);
