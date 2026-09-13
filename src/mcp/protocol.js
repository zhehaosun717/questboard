// A minimal MCP server over stdio: newline-delimited JSON-RPC 2.0 with initialize, ping, tools/list and
// tools/call. Kept dependency-free on purpose. Only protocol messages go to stdout; diagnostics go to stderr.
import readline from 'node:readline';

export const SUPPORTED_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

function toolResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

export function createMcpHandler({ name, version, instructions, tools }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const definitions = tools.map(({ handler, ...definition }) => definition);

  async function callTool(id, params) {
    const tool = byName.get(params && params.name);
    if (!tool) return rpcError(id, -32602, `unknown tool ${params && params.name}`);
    try {
      return rpcResult(id, toolResult(await tool.handler((params && params.arguments) || {})));
    } catch (error) {
      // Tool failures are results the model can read and act on, not protocol errors.
      return rpcResult(id, { content: [{ type: 'text', text: error.message }], isError: true });
    }
  }

  // Returns the response to write, or null for notifications.
  return async function handle(message) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return message && message.id !== undefined ? rpcError(message.id, -32600, 'invalid request') : null;
    }
    const { id, method, params } = message;
    const notification = id === undefined;
    if (method.startsWith('notifications/')) return null;
    if (method === 'initialize') {
      const requested = params && params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name, version },
        ...(instructions ? { instructions } : {}),
      });
    }
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'tools/list') return rpcResult(id, { tools: definitions });
    if (method === 'tools/call') return callTool(id, params);
    return notification ? null : rpcError(id, -32601, `method not found: ${method}`);
  };
}

export function serveStdio(handle, { input = process.stdin, output = process.stdout } = {}) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const write = (message) => output.write(`${JSON.stringify(message)}\n`);
  lines.on('line', async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write(rpcError(null, -32700, 'parse error'));
      return;
    }
    const messages = Array.isArray(message) ? message : [message];
    const responses = (await Promise.all(messages.map(handle))).filter(Boolean);
    if (Array.isArray(message)) { if (responses.length) write(responses); } else if (responses[0]) write(responses[0]);
  });
  return lines;
}
