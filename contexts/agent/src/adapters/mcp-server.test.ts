import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import type { AgentReadPort, BarsArgs } from '../application/agent-read-port.js';
import { createMcpServer } from './mcp-server.js';

async function connected(read: AgentReadPort) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(read).connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  return client;
}

describe('createMcpServer', () => {
  it('passes tool arguments to the read port unchanged and returns its value as JSON', async () => {
    const calls: BarsArgs[] = [];
    const client = await connected({
      bars: (args) => {
        calls.push(args);
        return Promise.resolve({ ok: true, value: { bars: [], next: null } });
      },
      instruments: () => Promise.resolve({ ok: true, value: [] }),
      plan: () => Promise.resolve({ ok: true, value: { plan: { id: 'free' } } }),
    });
    const result = await client.callTool({ name: 'get_bars', arguments: { instrument: 'BTCUSD', tf: '1h', limit: 5 } });
    expect(calls).toEqual([{ instrument: 'BTCUSD', tf: '1h', limit: 5, before: undefined }]);
    expect(result.structuredContent).toEqual({ result: { bars: [], next: null } });
    await client.close();
  });

  it('turns a refusal into a tool error with its code, message and upgrade link', async () => {
    const refusal = { ok: false as const, code: 'forbidden', message: 'no', upgradeUrl: 'https://example.com/up' };
    const client = await connected({
      bars: () => Promise.resolve(refusal),
      instruments: () => Promise.resolve(refusal),
      plan: () => Promise.resolve(refusal),
    });
    const result = await client.callTool({ name: 'get_plan', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual({
      error: { code: 'forbidden', message: 'no', upgradeUrl: 'https://example.com/up' },
    });
    await client.close();
  });

  it('rejects arguments of the wrong type before reaching the port', async () => {
    let reached = false;
    const client = await connected({
      bars: () => {
        reached = true;
        return Promise.resolve({ ok: true, value: {} });
      },
      instruments: () => Promise.resolve({ ok: true, value: [] }),
      plan: () => Promise.resolve({ ok: true, value: {} }),
    });
    const result = await client.callTool({ name: 'get_bars', arguments: { instrument: 'BTCUSD', tf: '1h', limit: 'many' } });
    expect(result.isError).toBe(true);
    expect(reached).toBe(false);
    await client.close();
  });
});
