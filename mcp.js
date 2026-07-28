// mcp.js — Streamable HTTP MCP endpoint logic for the Revenue Desk connector.
//
// Stateless JSON-RPC 2.0: each POST carries one message (or a batch array) and gets one JSON
// response — no SSE stream is needed for these quick read-only tools, which is a compliant
// Streamable HTTP mode. Bearer auth + the OAuth handshake live in oauth.js; the server wires them
// together (see server.js). The tools mirror the in-app "Ask Claude" assistant exactly.
import { TOOLS as ASSISTANT_TOOLS } from './assistant.js';

// The newest protocol version we implement; we echo the client's requested version when given.
const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'perq-revenue-desk', version: '1.0.0' };

// MCP tool descriptors = the assistant's schemas with input_schema -> inputSchema (MCP naming).
export const MCP_TOOLS = ASSISTANT_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id: id ?? null, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const toolText = (id, obj, isError) => rpcResult(id, {
  content: [{ type: 'text', text: (typeof obj === 'string' ? obj : JSON.stringify(obj)).slice(0, 200000) }],
  ...(isError ? { isError: true } : {}),
});

// Handle a single JSON-RPC message. Returns { status, body }; body === null means "no content"
// (a notification -> 202). `tools` maps tool name -> async executor.
export async function handleMcpMessage(msg, tools) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { status: 400, body: rpcError(msg && msg.id, -32600, 'Invalid Request') };
  }
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return { status: 200, body: rpcResult(id, {
        protocolVersion: (params && typeof params.protocolVersion === 'string') ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }) };
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { status: 202, body: null }; // notifications get no JSON-RPC response
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: MCP_TOOLS }) };
    case 'tools/call': {
      const name = params && params.name;
      const fn = name && tools[name];
      if (!fn) return { status: 200, body: toolText(id, `Unknown tool: ${name}`, true) };
      try {
        const out = await fn((params && params.arguments) || {});
        return { status: 200, body: toolText(id, out) };
      } catch (e) {
        return { status: 200, body: toolText(id, `Error: ${e.message}`, true) };
      }
    }
    default:
      // Ignore other notifications; error on unknown requests.
      if (method.startsWith('notifications/')) return { status: 202, body: null };
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}
