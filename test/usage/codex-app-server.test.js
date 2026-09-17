import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { tmpDir } from '../helpers.js';
import {
  CODEX_APP_SERVER_METHODS,
  resolveCodexExecutable,
  readCodexAppServer,
} from '../../src/usage/codexAppServer.js';
import { codexAppServer, EXPERIMENTAL_PROVIDERS, PROVIDERS } from '../../src/usage/providers.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'codex-app-server.synthetic.jsonl');
const FIXTURE_LINES = fs.readFileSync(FIXTURE, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const NOW = Date.parse('2026-09-16T12:00:00.000Z');

function serverLine(id, variant = 'normal') {
  return FIXTURE_LINES.find((line) => line._dir === 'server' && line.id === id && (variant === 'apiKey' ? line._variant === 'apiKeyAccount' : !line._variant));
}

function makeFakeChild({ account = serverLine(2), rate = serverLine(3), extra = [], respond = true } = {}) {
  const child = new EventEmitter();
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const writes = [];
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  };
  stdin.write = (text) => {
    writes.push(JSON.parse(text));
    if (!respond) return true;
    const request = writes.at(-1);
    if (request.method === 'initialize') queueMicrotask(() => stdout.emit('data', `${JSON.stringify(serverLine(1))}\n`));
    if (request.method === 'account/read') queueMicrotask(() => stdout.emit('data', `${JSON.stringify(account)}\n`));
    if (request.method === 'account/rateLimits/read') {
      queueMicrotask(() => {
        for (const line of extra) stdout.emit('data', `${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
        stdout.emit('data', `${JSON.stringify(rate)}\n`);
      });
    }
    return true;
  };
  return { child, writes };
}

function fakeSpawn(options = {}) {
  const fake = makeFakeChild(options);
  const result = { ...fake };
  result.spawnImpl = (command, args, spawnOptions) => {
    result.spawnCall = { command, args, options: spawnOptions };
    return result.child;
  };
  result.resolveImpl = () => (process.platform === 'win32' ? 'C:\\fake\\codex.exe' : 'codex');
  return result;
}

// A real Windows ENOENT surfaces as an async 'error' event on the child, not a synchronous throw from
// spawn() itself — spawn() returns an object first and Node emits 'error' on the next tick.
function makeErroringChild(message = 'raw child detail') {
  const child = new EventEmitter();
  child.stdin = { write: () => true };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  queueMicrotask(() => child.emit('error', new Error(message)));
  return child;
}

describe('Codex app-server usage adapter', () => {
  it('uses only the read-only handshake allowlist and maps the synthetic ChatGPT snapshot', async () => {
    const fake = fakeSpawn({ extra: [FIXTURE_LINES.find((line) => line.method === 'account/rateLimits/updated')] });
    const result = await readCodexAppServer({ spawnImpl: fake.spawnImpl, env: { PATH: 'p', HOME: 'h', OPENAI_API_KEY: 'must-not-pass' }, platform: 'linux', now: NOW });

    assert.deepEqual(fake.writes.map((message) => message.method), CODEX_APP_SERVER_METHODS);
    assert.deepEqual(fake.writes[2], { id: 2, method: 'account/read', params: { refreshToken: false } });
    assert.deepEqual(fake.writes[3], { id: 3, method: 'account/rateLimits/read', params: null });
    assert.equal(fake.spawnCall.command, 'codex');
    assert.deepEqual(fake.spawnCall.args, ['app-server']);
    assert.deepEqual(Object.keys(fake.spawnCall.options.env).sort(), ['HOME', 'PATH']);
    assert.equal(fake.spawnCall.options.env.OPENAI_API_KEY, undefined);
    assert.equal(result.state, 'ok');
    assert.deepEqual(result.windows, [{
      label: 'codex · 5 小时',
      usedPercent: null,
      resetsAt: '2000-01-01T00:00:00.000Z',
      state: 'reset',
    }]);
    assert.equal(result.plan, 'plus');
    assert.match(result.note, /live handshake/);
    assert.equal(result.diagnostics.ignoredServerMessages, 1);
    assert.equal(fake.child.killed, true);
    assert.ok(!JSON.stringify(result).includes('synthetic@example.invalid'));
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC'));
  });

  it('uses rateLimits when the by-limit map is absent and keeps over-limit percentages truthful', async () => {
    const rate = {
      _dir: 'server',
      id: 3,
      result: {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 120, windowDurationMins: 10080, resetsAt: NOW / 1000 + 3600 },
          secondary: { usedPercent: 7, windowDurationMins: 90, resetsAt: null },
          credits: { balance: '12.5', hasCredits: true, unlimited: false },
          individualLimit: { limit: '100', used: '40', remainingPercent: 60, resetsAt: NOW / 1000 + 3600 },
        },
        rateLimitsByLimitId: null,
        accountId: 'DROP-ME',
        rateLimitUpsell: { url: 'DROP-ME' },
        rateLimitResetCredits: { availableCount: 4, credits: [{ id: 'DROP-ME' }] },
      },
    };
    const fake = fakeSpawn({ rate });
    const result = await readCodexAppServer({ spawnImpl: fake.spawnImpl, resolveImpl: fake.resolveImpl, env: {}, now: NOW });
    assert.deepEqual(result.windows.map((window) => [window.label, window.usedPercent]), [['codex · 每周', 120], ['codex · 90 分钟', 7]]);
    assert.deepEqual(result.balances, [{ currency: 'unknown', amount: 12.5 }, { currency: 'unknown', amount: 60 }]);
    assert.ok(!JSON.stringify(result).includes('accountId'));
    assert.ok(!JSON.stringify(result).includes('rateLimitUpsell'));
    assert.ok(!JSON.stringify(result).includes('rateLimitResetCredits'));
    assert.ok(!JSON.stringify(result).includes('DROP-ME'));
  });

  it('shows a lone remainingPercent as a percentage window, never as a balance amount', async () => {
    const rate = {
      _dir: 'server',
      id: 3,
      result: {
        rateLimits: {
          limitId: 'codex',
          individualLimit: { remainingPercent: 60, resetsAt: NOW / 1000 + 3600 },
        },
        rateLimitsByLimitId: null,
      },
    };
    const fake = fakeSpawn({ rate });
    const result = await readCodexAppServer({ spawnImpl: fake.spawnImpl, resolveImpl: fake.resolveImpl, env: {}, now: NOW });
    assert.deepEqual(result.windows, [{
      label: 'codex · 额度',
      usedPercent: 40,
      resetsAt: '2026-09-16T13:00:00.000Z',
    }]);
    assert.deepEqual(result.balances, []);
  });

  it('labels windows by limit id when several limits share one duration', async () => {
    const rate = {
      _dir: 'server',
      id: 3,
      result: {
        rateLimits: null,
        rateLimitsByLimitId: {
          codex: { primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: null } },
          'gpt-5': { primary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: null } },
        },
      },
    };
    const fake = fakeSpawn({ rate });
    const result = await readCodexAppServer({ spawnImpl: fake.spawnImpl, resolveImpl: fake.resolveImpl, env: {}, now: NOW });
    assert.deepEqual(result.windows.map((window) => window.label), ['codex · 每周', 'gpt-5 · 每周']);
    assert.deepEqual(result.windows.map((window) => window.usedPercent), [10, 20]);
    assert.deepEqual(result.balances, []);
  });

  it('gives two limit ids that fail safeLabel distinct generated labels', async () => {
    const rate = {
      _dir: 'server',
      id: 3,
      result: {
        rateLimits: null,
        rateLimitsByLimitId: {
          'bad key 1': { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null } },
          'another bad key!!': { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: null } },
        },
      },
    };
    const fake = fakeSpawn({ rate });
    const result = await readCodexAppServer({ spawnImpl: fake.spawnImpl, resolveImpl: fake.resolveImpl, env: {}, now: NOW });
    assert.deepEqual(result.windows.map((window) => window.label), ['限额 1 · 5 小时', '限额 2 · 5 小时']);
    assert.deepEqual(result.windows.map((window) => window.usedPercent), [10, 20]);
  });

  it('drops a negative remainingPercent instead of showing more than 100% used', async () => {
    const rate = {
      _dir: 'server',
      id: 3,
      result: {
        rateLimits: {
          limitId: 'codex',
          individualLimit: { remainingPercent: -5, resetsAt: NOW / 1000 + 3600 },
        },
        rateLimitsByLimitId: null,
      },
    };
    const fake = fakeSpawn({ rate });
    const result = await readCodexAppServer({ spawnImpl: fake.spawnImpl, resolveImpl: fake.resolveImpl, env: {}, now: NOW });
    assert.deepEqual(result.windows, []);
    assert.deepEqual(result.balances, []);
  });

  it('flags a millisecond reset assumption and states that live confirmation is still needed', async () => {
    const rate = {
      _dir: 'server',
      id: 3,
      result: {
        rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 2000000000000 } },
        rateLimitsByLimitId: {},
      },
    };
    const fake = fakeSpawn({ rate });
    const result = await readCodexAppServer({ spawnImpl: fake.spawnImpl, resolveImpl: fake.resolveImpl, env: {}, now: NOW });
    assert.equal(result.windows[0].resetsAt, '2033-05-18T03:33:20.000Z');
    assert.equal(result.windows[0].resetUnitAssumed, true);
    assert.match(result.note, /按毫秒解释/);
    assert.match(result.note, /live handshake/);
  });

  it('returns not_configured for an API-key account without reading or exposing account data', async () => {
    const fake = fakeSpawn({ account: serverLine(2, 'apiKey') });
    const result = await readCodexAppServer({ spawnImpl: fake.spawnImpl, resolveImpl: fake.resolveImpl, env: {}, now: NOW });
    assert.equal(result.state, 'not_configured');
    assert.equal(result.note.includes('ChatGPT'), true);
    assert.equal(result.note.includes('API key'), true);
    assert.deepEqual(fake.writes.map((message) => message.method), ['initialize', 'initialized', 'account/read']);
    assert.ok(!JSON.stringify(result).includes('apiKey'));
  });

  it('counts malformed, unknown, and server-request frames without answering server requests', async () => {
    const serverRequest = { _dir: 'server', id: 90, method: 'item/commandExecution/requestApproval', params: { command: 'DROP-ME' } };
    const fake = fakeSpawn({ extra: ['not json', { unknown: true }, serverRequest] });
    const result = await readCodexAppServer({ spawnImpl: fake.spawnImpl, resolveImpl: fake.resolveImpl, env: {}, now: NOW });
    assert.equal(result.diagnostics.malformedFrames, 1);
    assert.equal(result.diagnostics.unknownFrames, 1);
    assert.equal(result.diagnostics.ignoredServerMessages, 1);
    assert.deepEqual(fake.writes.map((message) => message.method), CODEX_APP_SERVER_METHODS);
    assert.ok(!fake.writes.some((message) => message.id === 90));
  });

  it('kills its own fake child when the app-server misses the deadline', async () => {
    const fake = fakeSpawn({ respond: false });
    await assert.rejects(readCodexAppServer({ spawnImpl: fake.spawnImpl, resolveImpl: fake.resolveImpl, env: {}, deadlineMs: 20 }), /超时/);
    assert.equal(fake.child.killed, true);
  });

  it('resolves the native Windows package executable without considering a shim', () => {
    const expected = 'C:\\npm-bin\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
    const checked = [];
    const resolved = resolveCodexExecutable({
      platform: 'win32',
      arch: 'x64',
      env: { PATH: 'C:\\npm-bin' },
      existsImpl(candidate) {
        checked.push(candidate);
        return candidate === expected;
      },
    });
    assert.equal(resolved, expected);
    assert.ok(checked.length > 0);
    assert.ok(checked.every((candidate) => !/\.(?:cmd|bat)$/i.test(candidate)));
  });

  it('resolves the native Windows package executable for an arm64 host', () => {
    const expected = 'C:\\npm-bin\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-arm64\\vendor\\aarch64-pc-windows-msvc\\bin\\codex.exe';
    const checked = [];
    const resolved = resolveCodexExecutable({
      platform: 'win32',
      arch: 'arm64',
      env: { PATH: 'C:\\npm-bin' },
      existsImpl(candidate) {
        checked.push(candidate);
        return candidate === expected;
      },
    });
    assert.equal(resolved, expected);
    assert.ok(checked.length > 0);
    assert.ok(checked.every((candidate) => !/\.(?:cmd|bat)$/i.test(candidate)));
  });

  it('returns null for an unsupported Windows architecture without touching the filesystem', () => {
    const checked = [];
    const resolved = resolveCodexExecutable({
      platform: 'win32',
      arch: 'ia32',
      env: { PATH: 'C:\\npm-bin' },
      existsImpl(candidate) {
        checked.push(candidate);
        return true;
      },
    });
    assert.equal(resolved, null);
    assert.equal(checked.length, 0);
  });

  it('resolves the executable through an APPDATA-only npm root when PATH has no codex entry', () => {
    const expected = 'C:\\Users\\A\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
    const checked = [];
    const resolved = resolveCodexExecutable({
      platform: 'win32',
      arch: 'x64',
      env: { PATH: 'C:\\unrelated\\bin', APPDATA: 'C:\\Users\\A\\AppData\\Roaming' },
      existsImpl(candidate) {
        checked.push(candidate);
        return candidate === expected;
      },
    });
    assert.equal(resolved, expected);
    assert.ok(checked.includes(expected));
  });

  it('finds nothing when only APPDATA is set and the npm root has no codex package', () => {
    const resolved = resolveCodexExecutable({
      platform: 'win32',
      arch: 'x64',
      env: { APPDATA: 'C:\\Users\\A\\AppData\\Roaming' },
      existsImpl: () => false,
    });
    assert.equal(resolved, null);
  });

  it('spawns the injected native Windows executable without enabling a shell', async () => {
    const fake = fakeSpawn();
    const resolved = 'C:\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
    await readCodexAppServer({
      spawnImpl: fake.spawnImpl,
      resolveImpl: () => resolved,
      env: {},
      platform: 'win32',
      now: NOW,
    });
    assert.equal(fake.spawnCall.command, resolved);
    assert.ok(!/\.(?:cmd|bat)$/i.test(fake.spawnCall.command));
    assert.equal(fake.spawnCall.options.shell, undefined);
    assert.equal(fake.spawnCall.options.stdio[0], 'pipe');
  });

  it('reports a missing Windows executable before calling spawn', async () => {
    let spawnCalls = 0;
    await assert.rejects(
      readCodexAppServer({
        resolveImpl: () => null,
        spawnImpl: () => { spawnCalls += 1; throw new Error('must not spawn'); },
        env: {},
        platform: 'win32',
        now: NOW,
      }),
      (error) => error && error.code === 'not_found' && /未找到 Codex 命令/.test(error.message),
    );
    assert.equal(spawnCalls, 0);
  });

  it('falls back to a stale local-log answer when the child cannot start', async () => {
    const homedir = tmpDir('qb-codex-fallback-');
    const sessionDir = path.join(homedir, '.codex', 'sessions', '2026', '09');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'rollout-fallback.jsonl'), JSON.stringify({
      timestamp: '2026-09-16T10:00:00Z',
      payload: { rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: NOW / 1000 + 3600 } } },
    }));
    // A found executable that then fails to start (the child's 'error' event) must reach this fallback
    // exactly as an unresolved command does; resolveImpl here always returns a command so this exercises
    // the spawn-failure branch, not the not-found branch.
    const result = await codexAppServer.fetch({
      resolveImpl: () => 'C:\\fake\\codex.exe',
      spawnImpl: () => makeErroringChild('raw child detail'),
      env: {},
      homedir,
      now: NOW,
      platform: 'win32',
    });
    assert.equal(result.source, 'local-log');
    assert.equal(result.state, 'stale');
    assert.equal(result.windows[0].usedPercent, 12);
    assert.match(result.note, /local-log/);
    assert.ok(!JSON.stringify(result).includes('raw child detail'));
  });

  it('rejects with the Chinese spawn-failure reason and the start code when the child emits error before responding', async () => {
    await assert.rejects(
      readCodexAppServer({
        resolveImpl: () => 'C:\\fake\\codex.exe',
        spawnImpl: () => makeErroringChild('raw child detail'),
        env: {},
        platform: 'win32',
        now: NOW,
      }),
      (error) => error && error.code === 'start' && /Codex app-server 无法启动/.test(error.message) && !String(error.message).includes('raw child detail'),
    );
  });

  it('labels the missing executable in the stale fallback note', async () => {
    const result = await codexAppServer.fetch({
      resolveImpl: () => null,
      spawnImpl: () => { throw new Error('must not spawn'); },
      env: {},
      homedir: tmpDir('qb-codex-missing-'),
      now: NOW,
      platform: 'win32',
    });
    assert.equal(result.source, 'local-log');
    assert.equal(result.state, 'stale');
    assert.equal(result.stale, true);
    assert.match(result.note, /未找到 Codex 命令/);
  });

  it('registers the app-server provider separately from the unchanged local-log provider', () => {
    assert.equal(PROVIDERS.includes(codexAppServer), false);
    assert.equal(EXPERIMENTAL_PROVIDERS.includes(codexAppServer), true);
    assert.equal(codexAppServer.id, 'codex-app-server');
    assert.equal(codexAppServer.access, 'official-cli');
    assert.equal(codexAppServer.credentialType, 'codex-chatgpt-session');
  });

  it('skips non-absolute PATH entries such as . so a relative codex.exe is never picked', () => {
    const checked = [];
    const fakeExists = (target) => {
      checked.push(target);
      if (target === 'codex.exe' || target === '.\\codex.exe' || target === 'relative\\codex.exe') {
        return true;
      }
      return false;
    };

    const resolved = resolveCodexExecutable({
      platform: 'win32',
      arch: 'x64',
      env: { PATH: '.;relative;sub\\dir', APPDATA: '', LOCALAPPDATA: '' },
      existsImpl: fakeExists,
    });

    assert.equal(resolved, null);
    assert.equal(checked.length, 0, 'non-absolute PATH entries must be skipped without checking the filesystem');
  });

  it('picks absolute PATH entries while ignoring . and relative paths in PATH', () => {
    const checked = [];
    const safeExe = 'C:\\safe\\npm\\codex.exe';
    const fakeExists = (target) => {
      checked.push(target);
      return target === safeExe;
    };

    const resolved = resolveCodexExecutable({
      platform: 'win32',
      arch: 'x64',
      env: { PATH: '.;relative;C:\\safe\\npm', APPDATA: '', LOCALAPPDATA: '' },
      existsImpl: fakeExists,
    });

    assert.equal(resolved, safeExe);
    assert.ok(!checked.some((p) => p.startsWith('.\\') || p === 'codex.exe' || p.startsWith('relative\\')));
  });
});
