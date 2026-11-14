// The MCP server for one agent request (M4-02), with the official SDK
// (@modelcontextprotocol/sdk). The platform creates one per HTTP request,
// bound to that request's principal, and serves it over Streamable HTTP.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AgentReadPort, ReadResult } from '../application/agent-read-port.js';
import { READ_TOOLS } from '../application/read-tools.js';

export const MCP_SERVER_NAME = 'investanswers-charts';

function toolResult(result: ReadResult<unknown>) {
  if (result.ok) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result.value) }],
      structuredContent: { result: result.value },
    };
  }
  const error = { code: result.code, message: result.message, ...(result.upgradeUrl === undefined ? {} : { upgradeUrl: result.upgradeUrl }) };
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error }) }] };
}

export function createMcpServer(read: AgentReadPort, version = '0.1.0'): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version });
  for (const tool of READ_TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } },
      async (args: Record<string, unknown>) => toolResult(await tool.run(read, args)),
    );
  }
  return server;
}
