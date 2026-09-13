import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createMcpHandler, serveStdio, SUPPORTED_VERSIONS } from '../../src/mcp/protocol.js';

const handle = createMcpHandler({
  name: 'test', version: '1.0.0', instructions: 'hi',
  tools: [
    { name: 'echo', description: 'echo', inputSchema: { type: 'object' }, handler: async (args) => ({ got: args }) },
    { name: 'boom', description: 'fails', inputSchema: { type: 'object' }, handler: async () => { throw new Error('board server is not running'); } },
  ],
});

describe('mcp protocol', () => {
  it('negotiates the protocol version and advertises tools', async () => {
    const known = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(known.result.protocolVersion, '2025-06-18');
    assert.deepEqual(known.result.serverInfo, { name: 'test', version: '1.0.0' });
    const future = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
    assert.equal(future.result.protocolVersion, SUPPORTED_VERSIONS[0]);
    const list = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert.deepEqual(list.result.tools.map((t) => t.name), ['echo', 'boom']);
    assert.equal(list.result.tools[0].handler, undefined);
  });

  it('returns tool failures as readable results and protocol mistakes as errors', async () => {
    assert.deepEqual((await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } })).result.content[0].text, JSON.stringify({ got: { a: 1 } }, null, 2));
    const failed = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boom' } });
    assert.deepEqual([failed.result.isError, failed.result.content[0].text], [true, 'board server is not running']);
    assert.equal((await handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } })).error.code, -32602);
    assert.equal((await handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' })).error.code, -32601);
    assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.equal((await handle({ id: 8, method: 'ping' })).error.code, -32600);
  });

  it('speaks newline-delimited JSON over streams and answers parse errors', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    serveStdio(handle, { input, output });
    const received = [];
    output.on('data', (chunk) => received.push(...chunk.toString().split('\n').filter(Boolean).map((l) => JSON.parse(l))));
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\nnot json\n');
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Replies are matched by id, not by order: an async reply can follow a later line's immediate one.
    assert.deepEqual(received.find((m) => m.id === 1), { jsonrpc: '2.0', id: 1, result: {} });
    assert.equal(received.find((m) => m.id === null).error.code, -32700);
    assert.equal(received.length, 2);
  });
});
