// A child process of the load test (M2-04): runs a group of clients and
// reports back over IPC, so clients do not share the server's event loop.

import type { PublishedSummary } from './load-live-clients.js';
import { runClients } from './load-live-clients.js';

type Message = { kind: 'start'; url: string; ids: number[]; wave: number } | { kind: 'finish'; summary: PublishedSummary };

let running: ReturnType<typeof runClients> | undefined;

process.on('message', (message: Message) => {
  if (message.kind === 'start') {
    running = runClients(message.url, message.ids, message.wave);
    running.then(
      () => process.send?.({ kind: 'ready' }),
      (error: unknown) => process.send?.({ kind: 'error', error: String(error) }),
    );
    return;
  }
  void running?.then((clients) => process.send?.({ kind: 'report', report: clients.finish(message.summary) }));
});
