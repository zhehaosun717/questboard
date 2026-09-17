import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './fixture.js';
import { resolveAttemptReport } from '../../src/core/reportEvidence.js';
import { isLoaderEnv, validateAdventurer } from '../../src/core/roster.js';
import { runCommand } from '../../src/usage/common.js';
import { POWERSHELL_PATH } from '../../src/usage/antigravity.js';

function request(fx, pathname, { method = 'GET', headers = {}, body = '', noHost = false, closeAfterFirstChunk = false } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = http.request({
      hostname: '127.0.0.1', port: fx.server.address().port, path: pathname, method,
      headers, setHost: !noHost,
    }, (response) => {
      response.on('data', (chunk) => {
        chunks.push(chunk);
        if (closeAfterFirstChunk) {
          response.destroy();
          resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: response.headers });
        }
      });
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
      response.on('error', (error) => {
        if (!closeAfterFirstChunk) reject(error);
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const jsonBody = (value) => JSON.stringify(value);
const parse = (response) => JSON.parse(response.text);

describe('QB-SEC-1 security bundle', () => {
  let fx;
  after(async () => { if (fx) await fx.close(); });

  it('checks the local Host before all read routes and allows a CLI request without Host', async () => {
    fx = await startFixture({ usage: { report: async () => ({ providers: [] }) } });
    const port = fx.server.address().port;
    const foreign = { host: `rebind.attacker.example:${port}` };
    const routes = [
      '/api/quests', '/api/events', '/api/quests/RUN-4', '/api/quests/RUN-4/report',
      '/api/roster', '/api/lanes', '/api/settings', '/api/threads', '/api/usage',
    ];
    for (const route of routes) {
      const refused = await request(fx, route, { headers: foreign });
      assert.equal(refused.status, 403, route);
      assert.match(parse(refused).error, /rebind\.attacker\.example/);
      assert.match(parse(refused).error, /[\u4e00-\u9fff]/u);
      const local = await request(fx, route, { headers: { host: `127.0.0.1:${port}` } });
      assert.notEqual(local.status, 403, route);
    }
    const streamRefused = await request(fx, '/api/quests/stream', { headers: foreign });
    assert.equal(streamRefused.status, 403);
    const streamLocal = await request(fx, '/api/quests/stream', {
      headers: { host: `127.0.0.1:${port}` }, closeAfterFirstChunk: true,
    });
    assert.equal(streamLocal.status, 200);
    assert.match(streamLocal.text, /event: hello/);
    const noHost = await request(fx, '/api/quests', { noHost: true });
    assert.notEqual(noHost.status, 403);
  });

  it('refuses a symlinked report candidate even when it points at an in-project secret', () => {
    const secret = path.join(fx.project.root, '.env');
    const candidate = path.join(fx.project.root, '.work', 'oc', 'mod1.md');
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(secret, 'PROJECT_SECRET=do-not-show\n');
    try {
      fs.symlinkSync(secret, candidate, 'file');
    } catch {
      return;
    }
    const found = resolveAttemptReport({
      config: fx.project.config,
      quest: { assignee: { name: 'mod1', lane: 'opencode', at: '2026-09-14T00:00:00.000Z', attemptId: 'a1' } },
    });
    assert.equal(found.source, 'none');
    assert.match(found.reason, /链接/);
    assert.doesNotMatch(found.reason, /PROJECT_SECRET/);
  });

  it('denies loader environment variables and leading option values in a single card and bulk apply', async () => {
    const single = await request(fx, '/api/roster', {
      method: 'POST',
      headers: { host: `127.0.0.1:${fx.server.address().port}`, 'content-type': 'application/json' },
      body: jsonBody({ adventurer: { id: 'sec-card', name: 'Security', provider: 'test', lane: 'codex', model: 'ok', family: 'ok', env: { NODE_OPTIONS: '--require evil' } } }),
    });
    assert.equal(single.status, 400);
    assert.match(parse(single).error, /加载方式/);
    const bulk = await request(fx, '/api/roster/bulk/apply', {
      method: 'POST',
      headers: { host: `127.0.0.1:${fx.server.address().port}`, 'content-type': 'application/json' },
      body: jsonBody({ ids: ['codex-luna'], patch: { env: { set: { PATH: 'evil' } } } }),
    });
    assert.equal(bulk.status, 400);
    assert.match(parse(bulk).error, /加载方式/);
    assert.throws(() => validateAdventurer({ id: 'dash-model', name: 'x', provider: 'x', lane: 'codex', model: '--help', family: 'x' }), /不能以 - 开头/);
    assert.throws(() => validateAdventurer({ id: 'dash-variant', name: 'x', provider: 'x', lane: 'codex', model: 'x', family: 'x', variant: '--help' }), /不能以 - 开头/);
    assert.throws(() => validateAdventurer({ id: 'dash-agent', name: 'x', provider: 'x', lane: 'codex', model: 'x', family: 'x', agent: '--help' }), /不能以 - 开头/);
  });

  it('uses the reviewed loader policy through both roster routes, keeps provider settings, and rejects legacy cards on save', async () => {
    const port = fx.server.address().port;
    const headers = { host: `127.0.0.1:${port}`, 'content-type': 'application/json' };
    const loaderRefusal = /\u52a0\u8f7d\u65b9\u5f0f/u;
    const chineseRefusal = /[\u4e00-\u9fff]/u;
    const cannotSet = /\u4e0d\u80fd\u8bbe\u7f6e\u5b83/u;
    const deniedNames = [
      'LD_AUDIT', 'PYTHONHOME', 'RUBYLIB', 'PERL5LIB', 'LUA_PATH', 'LUA_CPATH',
      'ld_audit', 'Ld_Audit', '-LD_PRELOAD',
      // Round 3 ruling: the .NET/CoreCLR profiler loaders and the remaining tool-bootstrap/pager families.
      'COR_ENABLE_PROFILING', 'corECLR_PROFILER', 'COMPLUS_X', 'PHPRC', 'QT_PLUGIN_PATH', 'EDITOR', 'SSLKEYLOGFILE',
      // Round 6: browser-download mirror families make a worker download and run a browser binary.
      'PUPPETEER_DOWNLOAD_BASE_URL', 'PLAYWRIGHT_DOWNLOAD_HOST', 'CYPRESS_DOWNLOAD_MIRROR', 'ELECTRON_MIRROR',
    ];

    for (const [index, name] of deniedNames.entries()) {
      const single = await request(fx, '/api/roster', {
        method: 'POST', headers,
        body: jsonBody({ adventurer: {
          id: `sec-policy-${index}`, name: 'Policy', provider: 'test', lane: 'codex', model: 'ok', family: 'ok',
          env: { [name]: 'synthetic-loader.so' },
        } }),
      });
      assert.equal(single.status, 400, name);
      const singleError = parse(single).error;
      assert.match(singleError, chineseRefusal, name);
      assert.match(singleError, cannotSet, name);
      if (!name.startsWith('-')) assert.match(singleError, loaderRefusal, name);
      assert.ok(singleError.includes(name), name);

      const bulk = await request(fx, '/api/roster/bulk/apply', {
        method: 'POST', headers,
        body: jsonBody({ ids: ['codex-luna'], patch: { env: { set: { [name]: 'synthetic-loader.so' } } } }),
      });
      assert.equal(bulk.status, 400, name);
      const bulkError = parse(bulk).error;
      assert.match(bulkError, chineseRefusal, name);
      assert.match(bulkError, cannotSet, name);
      if (!name.startsWith('-')) assert.match(bulkError, loaderRefusal, name);
      assert.ok(bulkError.includes(name), name);
    }

    const positiveValues = [
      ['OPENAI_BASE_URL', 'https://api.example.test/v1'],
      ['ANTHROPIC_MODEL', 'claude-test'],
      ['DEEPSEEK_MODEL', 'deepseek-test'],
    ];
    for (const [index, [name, value]] of positiveValues.entries()) {
      const single = await request(fx, '/api/roster', {
        method: 'POST', headers,
        body: jsonBody({ adventurer: {
          id: `sec-positive-${index}`, name: 'Positive', provider: 'test', lane: 'codex', model: 'ok', family: 'ok',
          env: { [name]: value },
        } }),
      });
      assert.equal(single.status, 200, name);
      assert.equal(parse(single).adventurer.env[name], value, name);

      const bulk = await request(fx, '/api/roster/bulk/apply', {
        method: 'POST', headers,
        body: jsonBody({ ids: ['codex-luna'], patch: { env: { set: { [name]: value } } } }),
      });
      assert.equal(bulk.status, 200, name);
      assert.equal(parse(bulk).counts.changed, 1, name);
    }

    const rosterBeforeLegacy = fs.readFileSync(fx.home.roster);
    const currentRoster = JSON.parse(rosterBeforeLegacy.toString('utf8'));
    const legacyCard = {
      id: 'legacy-loader', name: 'Legacy', provider: 'test', lane: 'codex', model: 'ok', family: 'ok',
      env: { LD_AUDIT: 'legacy-loader.so' },
    };
    const legacyBytes = Buffer.from(JSON.stringify({ adventurers: [...currentRoster.adventurers, legacyCard] }));
    try {
      fs.writeFileSync(fx.home.roster, legacyBytes);

      // A legacy card must never brick the board: GET still succeeds, with a note.
      const getRoster = await request(fx, '/api/roster', { headers: { host: `127.0.0.1:${port}` } });
      assert.equal(getRoster.status, 200);
      const legacyOnBoard = parse(getRoster).adventurers.find((a) => a.id === 'legacy-loader');
      assert.ok(legacyOnBoard, 'the legacy card still shows on the board');
      assert.equal(legacyOnBoard.envPolicy.variable, 'LD_AUDIT');
      assert.match(legacyOnBoard.envPolicy.reason, chineseRefusal);
      assert.match(legacyOnBoard.envPolicy.reason, loaderRefusal);

      // A single save that keeps the offending variable is refused.
      const single = await request(fx, '/api/roster', {
        method: 'POST', headers,
        body: jsonBody({ adventurer: { ...legacyCard, name: 'Legacy repaired' } }),
      });
      assert.equal(single.status, 400);
      const singleError = parse(single).error;
      assert.match(singleError, loaderRefusal);
      assert.ok(singleError.includes('LD_AUDIT'));
      assert.deepEqual(fs.readFileSync(fx.home.roster), legacyBytes, 'single save must not strip the legacy value');

      // A bulk patch that does not touch env, but keeps the offending variable, is refused the same way.
      const bulkKeep = await request(fx, '/api/roster/bulk/apply', {
        method: 'POST', headers,
        body: jsonBody({ ids: ['legacy-loader'], patch: { variant: 'repaired' } }),
      });
      assert.equal(bulkKeep.status, 400);
      assert.match(parse(bulkKeep).error, loaderRefusal);
      assert.ok(parse(bulkKeep).error.includes('LD_AUDIT'));
      assert.deepEqual(fs.readFileSync(fx.home.roster), legacyBytes, 'bulk save must not strip the legacy value');

      // Another, unrelated card's save is not blocked by this legacy card sitting elsewhere in the file.
      const otherCard = await request(fx, '/api/roster', {
        method: 'POST', headers,
        body: jsonBody({ adventurer: { id: 'sec-not-legacy', name: 'Not legacy', provider: 'test', lane: 'codex', model: 'ok', family: 'ok' } }),
      });
      assert.equal(otherCard.status, 200, otherCard.text);
      assert.deepEqual(JSON.parse(fs.readFileSync(fx.home.roster, 'utf8')).adventurers.find((a) => a.id === 'legacy-loader').env, { LD_AUDIT: 'legacy-loader.so' });

      // A single save that drops the offending variable succeeds.
      const repaired = await request(fx, '/api/roster', {
        method: 'POST', headers,
        body: jsonBody({ adventurer: { id: 'legacy-loader', name: 'Legacy repaired', provider: 'test', lane: 'codex', model: 'ok', family: 'ok' } }),
      });
      assert.equal(repaired.status, 200, repaired.text);
      assert.equal('env' in parse(repaired).adventurer, false);
    } finally {
      fs.writeFileSync(fx.home.roster, rosterBeforeLegacy);
    }

    // Bulk env.remove that drops the offending variable succeeds; a bulk set of another refused name is refused.
    const legacyBytes2 = Buffer.from(JSON.stringify({ adventurers: [...currentRoster.adventurers, legacyCard] }));
    try {
      fs.writeFileSync(fx.home.roster, legacyBytes2);
      const bulkRemove = await request(fx, '/api/roster/bulk/apply', {
        method: 'POST', headers,
        body: jsonBody({ ids: ['legacy-loader'], patch: { env: { remove: ['LD_AUDIT'] } } }),
      });
      assert.equal(bulkRemove.status, 200, bulkRemove.text);
      assert.equal(parse(bulkRemove).counts.changed, 1);
      assert.equal(JSON.parse(fs.readFileSync(fx.home.roster, 'utf8')).adventurers.find((a) => a.id === 'legacy-loader').env, undefined);

      const bulkSetAnother = await request(fx, '/api/roster/bulk/apply', {
        method: 'POST', headers,
        body: jsonBody({ ids: ['legacy-loader'], patch: { env: { set: { NODE_OPTIONS: '--require evil' } } } }),
      });
      assert.equal(bulkSetAnother.status, 400);
      assert.match(parse(bulkSetAnother).error, loaderRefusal);
      assert.ok(parse(bulkSetAnother).error.includes('NODE_OPTIONS'));
    } finally {
      fs.writeFileSync(fx.home.roster, rosterBeforeLegacy);
    }
  });

  it('uses the round-4 suffix/exact-name policy through both roster routes, and keeps the positive list working', async () => {
    const port = fx.server.address().port;
    const headers = { host: `127.0.0.1:${port}`, 'content-type': 'application/json' };
    const chineseRefusal = /[一-鿿]/u;
    const cannotSet = /不能设置它/u;
    const deniedNames = [
      // The Rust/Go toolchain and native-compiler bypass the round-3 review found.
      'RUSTC_WRAPPER', 'RUSTC', 'RUSTUP_TOOLCHAIN', 'RUSTUP_HOME', 'RUSTFLAGS', 'RUSTDOC', 'GOENV', 'CC', 'CXX',
      // Five suffix-rule names from the PM ruling.
      'X_PATH', 'MY_HOME', 'TOOL_FLAGS', 'FOO_OPTS', 'BARRC',
      // Mixed-case exact names.
      'cc', 'Cxx',
      // A card must not redirect a lane's config directory.
      'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    ];

    for (const [index, name] of deniedNames.entries()) {
      const single = await request(fx, '/api/roster', {
        method: 'POST', headers,
        body: jsonBody({ adventurer: {
          id: `sec-r4-${index}`, name: 'Policy', provider: 'test', lane: 'codex', model: 'ok', family: 'ok',
          env: { [name]: 'synthetic-value' },
        } }),
      });
      assert.equal(single.status, 400, name);
      const singleError = parse(single).error;
      assert.match(singleError, chineseRefusal, name);
      assert.match(singleError, cannotSet, name);
      assert.ok(singleError.includes(name), name);

      const bulk = await request(fx, '/api/roster/bulk/apply', {
        method: 'POST', headers,
        body: jsonBody({ ids: ['codex-luna'], patch: { env: { set: { [name]: 'synthetic-value' } } } }),
      });
      assert.equal(bulk.status, 400, name);
      const bulkError = parse(bulk).error;
      assert.match(bulkError, chineseRefusal, name);
      assert.match(bulkError, cannotSet, name);
      assert.ok(bulkError.includes(name), name);
    }

    const positiveValues = [
      ['OPENAI_BASE_URL', 'https://api.example.test/v1'],
      ['ANTHROPIC_MODEL', 'claude-test'],
      // Round 5: MY_TOOL_FLAG, FOO_BAR_2 and DEEPSEEK_API_KEY left this list (not a provider-setting shape).
      ['MY_TOOL_MODEL', 'tool-model'],
      ['FOO_REGION', 'eu-west'],
      ['ANTHROPIC_BASE_URL', 'https://gateway.example.test'],
      ['MODEL_NAME', 'gpt'],
      ['MAX_TOKENS', '4096'],
      ['API_TIMEOUT_MS', '30000'],
      ['PROVIDER_REGION', 'us-east'],
    ];
    for (const [index, [name, value]] of positiveValues.entries()) {
      const single = await request(fx, '/api/roster', {
        method: 'POST', headers,
        body: jsonBody({ adventurer: {
          id: `sec-r4-positive-${index}`, name: 'Positive', provider: 'test', lane: 'codex', model: 'ok', family: 'ok',
          env: { [name]: value },
        } }),
      });
      assert.equal(single.status, 200, name);
      assert.equal(parse(single).adventurer.env[name], value, name);

      const bulk = await request(fx, '/api/roster/bulk/apply', {
        method: 'POST', headers,
        body: jsonBody({ ids: ['codex-astra'], patch: { env: { set: { [name]: value } } } }),
      });
      assert.equal(bulk.status, 200, name);
      assert.equal(parse(bulk).counts.changed, 1, name);
    }
  });

  it('gives a plain Chinese message naming the variable for invalid env names on both routes, including a lower-case bulk remove', async () => {
    const port = fx.server.address().port;
    const headers = { host: `127.0.0.1:${port}`, 'content-type': 'application/json' };
    const chineseRefusal = /[一-鿿]/u;

    for (const name of ['1ABC', 'A B']) {
      const single = await request(fx, '/api/roster', {
        method: 'POST', headers,
        body: jsonBody({ adventurer: { id: 'sec-r4-invalid', name: 'Invalid', provider: 'test', lane: 'codex', model: 'ok', family: 'ok', env: { [name]: 'x' } } }),
      });
      assert.equal(single.status, 400, name);
      const singleError = parse(single).error;
      assert.match(singleError, chineseRefusal, name);
      assert.match(singleError, /UPPER_SNAKE_CASE/, name);
      assert.ok(singleError.includes(name), name);

      const bulk = await request(fx, '/api/roster/bulk/apply', {
        method: 'POST', headers,
        body: jsonBody({ ids: ['codex-luna'], patch: { env: { set: { [name]: 'x' } } } }),
      });
      assert.equal(bulk.status, 400, name);
      const bulkError = parse(bulk).error;
      assert.match(bulkError, chineseRefusal, name);
      assert.match(bulkError, /UPPER_SNAKE_CASE/, name);
      assert.ok(bulkError.includes(name), name);
    }

    const bulkRemoveLowerCase = await request(fx, '/api/roster/bulk/apply', {
      method: 'POST', headers,
      body: jsonBody({ ids: ['codex-luna'], patch: { env: { remove: ['lower_case_name'] } } }),
    });
    assert.equal(bulkRemoveLowerCase.status, 400);
    const removeError = parse(bulkRemoveLowerCase).error;
    assert.match(removeError, chineseRefusal);
    assert.match(removeError, /UPPER_SNAKE_CASE/);
    assert.ok(removeError.includes('lower_case_name'));
  });

  it('records review override source and makes an identical retry a no-op', async () => {
    fx.project.write('docs/briefs/SEC-1.md', 'parent');
    fx.project.write('docs/briefs/REVIEW-SEC-1.md', 'review');
    assert.equal((await request(fx, '/api/quests', { method: 'POST', headers: { host: `127.0.0.1:${fx.server.address().port}`, 'content-type': 'application/json' }, body: jsonBody({ package: 'SEC-1', brief: 'docs/briefs/SEC-1.md' }) })).status, 201);
    const reviewPost = fx.server.store.post({ package: 'REVIEW-SEC-1', kind: 'review', brief: 'docs/briefs/REVIEW-SEC-1.md', parents: ['SEC-1'] });
    assert.ok(!reviewPost.errors, JSON.stringify(reviewPost.errors));
    const headers = { host: `127.0.0.1:${fx.server.address().port}`, 'content-type': 'application/json', 'x-questboard-source': 'mcp' };
    const first = await request(fx, '/api/quests/REVIEW-SEC-1/review-override', { method: 'POST', headers, body: jsonBody({ reason: '人工确认' }) });
    assert.equal(first.status, 200, first.text);
    assert.equal(parse(first).quest.reviewOverride.source, 'mcp');
    const beforeEvents = fx.events().length;
    const revision = parse(first).quest.revision;
    const second = await request(fx, '/api/quests/REVIEW-SEC-1/review-override', { method: 'POST', headers, body: jsonBody({ reason: '人工确认' }) });
    assert.equal(second.status, 200, second.text);
    assert.equal(parse(second).quest.revision, revision);
    assert.equal(fx.events().length, beforeEvents);
    assert.equal(fx.events().at(-1).source, 'mcp');
    const objectReason = await request(fx, '/api/quests/REVIEW-SEC-1/review-override', { method: 'POST', headers, body: jsonBody({ reason: { bad: true } }) });
    assert.equal(objectReason.status, 400);
    assert.match(parse(objectReason).error, /文字/);
  });

  it('uses a fixed child cwd, disables default current-directory lookup, and an absolute PowerShell path', async () => {
    let options;
    await runCommand('fixed-command', [], {
      env: { PATH: 'test-path' },
      execFileImpl: (_file, _args, received, callback) => { options = received; callback(null, 'ok', ''); },
    });
    assert.equal(options.cwd, os.homedir());
    assert.equal(options.env.NoDefaultCurrentDirectoryInExePath, '1');
    assert.match(POWERSHELL_PATH, /(?:^|[\\/])powershell\.exe$/i);
    assert.ok(/^[A-Za-z]:[\\/]/.test(POWERSHELL_PATH) || POWERSHELL_PATH.startsWith('/'));
  });

  it('returns honest 400/413 responses for malformed paths and oversized bodies', async () => {
    const malformed = await request(fx, '/api/quests/%E0%A4%A', { headers: { host: `127.0.0.1:${fx.server.address().port}` } });
    assert.equal(malformed.status, 400);
    assert.equal(parse(malformed).error, '地址编码不正确');
    const tooLarge = await request(fx, '/api/quests', {
      method: 'POST',
      headers: { host: `127.0.0.1:${fx.server.address().port}`, 'content-type': 'application/json', 'content-length': String(256 * 1024 + 1) },
      body: `{"package":"SEC-BIG","brief":"docs/briefs/SEC-BIG.md","title":"${'x'.repeat(256 * 1024)}"}`,
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(parse(tooLarge).error, '请求内容太大');
  });
});

// Round 5 ruling: card env moves to an allow shape; the deny list stays as defence in depth.
describe('QB-SEC-1 round 5: card env allow shapes through both roster routes', () => {
  const chineseRefusal = /[一-鿿]/u;
  const notAllowed = /不是卡片可以设置的：卡片只能带模型服务的设置/u;
  const cannotSet = /不能设置它/u;
  // The round-4 review's bypasses, its medium and weak lists, and the round-4 positives that are not a
  // provider-setting shape.
  const refusedNames = [
    'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG', 'OPENCODE_PERMISSION', 'CLAUDE_CODE_SHELL_PREFIX', 'CLAUDE_ENV_FILE',
    'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'KUBECONFIG', 'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES', 'TARGET_CC', 'HOST_CC', 'CC_X86_64_PC_WINDOWS_MSVC',
    'CXX_X86_64_PC_WINDOWS_MSVC', 'CPP', 'FC', 'OBJCOPY', 'GH_PAGER', 'GH_EDITOR', 'MANPAGER', 'SUDO_EDITOR',
    'VIMINIT', 'EXINIT',
    'TERMINFO_DIRS', 'IPYTHONDIR', 'MPLCONFIGDIR', 'FTP_PROXY', 'GRPC_PROXY', 'SOCKS_PROXY', 'SYSTEMDRIVE',
    'PROGRAMW6432', 'ALLUSERSPROFILE', 'DOCKER_HOST', 'DOCKER_CONFIG', 'R_LIBS_USER', 'BUN_INSPECT',
    'GEMINI_SYSTEM_MD', 'MSBUILDSTARTUPDIRECTORY', 'LC_ALL',
    'MY_TOOL_FLAG', 'FOO_BAR_2', 'DEEPSEEK_API_KEY', 'TOKEN',
  ];
  const positive = [
    ['OPENAI_BASE_URL', 'https://api.example.test/v1'],
    ['ANTHROPIC_BASE_URL', 'https://gateway.example.test'],
    ['DEEPSEEK_MODEL', 'deepseek-test'],
    ['MY_TOOL_MODEL', 'tool-model'],
    ['FOO_REGION', 'eu-west'],
    ['MAX_TOKENS', '4096'],
    ['MODEL_NAME', 'gpt'],
    ['API_TIMEOUT_MS', '30000'],
    ['OC_AGENT', 'build'], // allowed only by this project's policy.cardEnvAllow
  ];
  let fx;
  after(async () => { if (fx) await fx.close(); });

  const headers = () => ({ host: `127.0.0.1:${fx.server.address().port}`, 'content-type': 'application/json' });
  const saveCard = (id, env) => request(fx, '/api/roster', {
    method: 'POST', headers: headers(),
    body: jsonBody({ adventurer: { id, name: 'Round 5', provider: 'test', lane: 'codex', model: 'ok', family: 'ok', ...(env === undefined ? {} : { env }) } }),
  });
  const bulk = (id, patch) => request(fx, '/api/roster/bulk/apply', { method: 'POST', headers: headers(), body: jsonBody({ ids: [id], patch }) });

  function assertRefused(response, name, expected) {
    assert.equal(response.status, 400, `${name}: ${response.text}`);
    const error = parse(response).error;
    assert.match(error, chineseRefusal, name);
    assert.ok(error.includes(name), `${name}: ${error}`);
    assert.match(error, expected, `${name}: ${error}`);
    return error;
  }

  it('refuses every name outside the allowed shapes, and every deny hit, on both routes', async () => {
    fx = await startFixture({ projectOverrides: { policy: {
      bannedModelPatterns: ['-fast(\\b|-)', 'gpt-5\\.5'], bannedAgents: ['Sisyphus'],
      cardEnvAllow: ['OC_AGENT', 'NODE_OPTIONS', 'CODEX_HOME'],
    } } });
    assert.deepEqual(fx.project.config.policy.cardEnvAllow, ['OC_AGENT', 'NODE_OPTIONS', 'CODEX_HOME']);
    const rosterBefore = fs.readFileSync(fx.home.roster);
    for (const [index, name] of refusedNames.entries()) {
      const expected = isLoaderEnv(name) ? cannotSet : notAllowed;
      const single = assertRefused(await saveCard(`r5-refused-${index}`, { [name]: 'synthetic-value' }), name, expected);
      if (expected === notAllowed) {
        assert.ok(single.includes('_BASE_URL、_MODEL、_REGION'), single);
        assert.ok(single.includes('policy.cardEnvAllow'), single);
      }
      assertRefused(await bulk('codex-luna', { env: { set: { [name]: 'synthetic-value' } } }), name, expected);
    }
    // A deny hit wins over the project's own list and over an allowed shape.
    for (const name of ['NODE_OPTIONS', 'CODEX_HOME', 'PYTHON_MODEL', 'NODE_BASE_URL']) {
      assertRefused(await saveCard('r5-deny-wins', { [name]: 'synthetic-value' }), name, cannotSet);
      assertRefused(await bulk('codex-luna', { env: { set: { [name]: 'synthetic-value' } } }), name, cannotSet);
    }
    assert.deepEqual(fs.readFileSync(fx.home.roster), rosterBefore, 'no refused request wrote the roster');
  });

  it('accepts the allowed shapes, the exact names and a policy.cardEnvAllow name on both routes', async () => {
    for (const [index, [name, value]] of positive.entries()) {
      const single = await saveCard(`r5-positive-${index}`, { [name]: value });
      assert.equal(single.status, 200, `${name}: ${single.text}`);
      assert.equal(parse(single).adventurer.env[name], value, name);

      assert.equal((await saveCard(`r5-bulk-${index}`)).status, 200);
      const viaBulk = await bulk(`r5-bulk-${index}`, { env: { set: { [name]: value } } });
      assert.equal(viaBulk.status, 200, `${name}: ${viaBulk.text}`);
      assert.equal(parse(viaBulk).counts.changed, 1, name);
      const saved = JSON.parse(fs.readFileSync(fx.home.roster, 'utf8')).adventurers.find((a) => a.id === `r5-bulk-${index}`);
      assert.deepEqual(saved.env, { [name]: value }, name);
    }
  });

  it('gives Chinese refusals for the env shape, the variable cap, the value length and a key-shaped value on both routes', async () => {
    const shape = /必须是「变量名: 值」这样的对象/u;
    assertRefused(await saveCard('r5-shape', []), 'env', shape);
    assertRefused(await bulk('codex-luna', { env: { set: [] } }), 'env.set', shape);
    assertRefused(await bulk('codex-luna', { env: [] }), 'patch.env', shape);

    const eleven = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`P${i}_MODEL`, 'x']));
    assertRefused(await saveCard('r5-many', eleven), 'env', /最多只能设置 10 个环境变量/u);
    assertRefused(await bulk('codex-luna', { env: { set: eleven } }), 'env.set', /最多只能设置 10 个环境变量/u);

    const long = { OPENAI_BASE_URL: 'x'.repeat(201) };
    assertRefused(await saveCard('r5-long', long), 'OPENAI_BASE_URL', /的值必须是文字，最长 200 个字符/u);
    assertRefused(await bulk('codex-luna', { env: { set: long } }), 'OPENAI_BASE_URL', /的值必须是文字，最长 200 个字符/u);

    const keyShaped = { DEEPSEEK_MODEL: 'sk-synthetic-not-a-key' };
    const singleKey = assertRefused(await saveCard('r5-key', keyShaped), 'DEEPSEEK_MODEL', /的值看起来像密钥/u);
    const bulkKey = assertRefused(await bulk('codex-luna', { env: { set: keyShaped } }), 'DEEPSEEK_MODEL', /的值看起来像密钥/u);
    for (const error of [singleKey, bulkKey]) assert.ok(!error.includes('sk-synthetic-not-a-key'), 'the value itself is never echoed');

    const tooManyRemovals = Array.from({ length: 11 }, (_, i) => `P${i}_MODEL`);
    assertRefused(await bulk('codex-luna', { env: { remove: tooManyRemovals } }), 'remove', /最多只能删除 10 个环境变量/u);
  });

  it('loads a legacy card outside the allowed shapes with a note, refuses to dispatch it, and lets env.remove repair it', async () => {
    const rosterBefore = fs.readFileSync(fx.home.roster);
    const current = JSON.parse(rosterBefore.toString('utf8'));
    const legacy = {
      id: 'r5-legacy', name: 'Legacy', provider: 'test', lane: 'codex', model: 'ok', family: 'ok',
      env: { OPENCODE_CONFIG_CONTENT: '{"mcp":{}}' },
    };
    try {
      fs.writeFileSync(fx.home.roster, JSON.stringify({ adventurers: [...current.adventurers, legacy] }));
      const roster = await request(fx, '/api/roster', { headers: { host: `127.0.0.1:${fx.server.address().port}` } });
      assert.equal(roster.status, 200);
      const onBoard = parse(roster).adventurers.find((a) => a.id === 'r5-legacy');
      assert.equal(onBoard.envPolicy.variable, 'OPENCODE_CONFIG_CONTENT');
      assert.match(onBoard.envPolicy.reason, notAllowed);

      fx.project.write('docs/briefs/SECR-5.md', 'round five');
      assert.equal((await request(fx, '/api/quests', { method: 'POST', headers: headers(), body: jsonBody({ package: 'SECR-5', brief: 'docs/briefs/SECR-5.md' }) })).status, 201);
      const callsBefore = fx.calls.length;
      const assigned = await request(fx, '/api/quests/SECR-5/assign', { method: 'POST', headers: headers(), body: jsonBody({ adventurer: 'r5-legacy' }) });
      assert.equal(assigned.status, 409, assigned.text);
      const reason = parse(assigned).reasons.find((item) => item.code === 'env_policy');
      assert.ok(reason, assigned.text);
      assert.match(reason.message, /OPENCODE_CONFIG_CONTENT/);
      assert.match(reason.message, /这张卡不能派遣/);
      assert.equal(fx.calls.length, callsBefore, 'no runner step for a legacy card');
      assert.equal(fx.events().some((event) => event.event === 'assigned' && event.package === 'SECR-5'), false);

      // A patch that keeps the variable is refused (the result is validated); removing it repairs the card.
      assertRefused(await bulk('r5-legacy', { variant: 'high' }), 'OPENCODE_CONFIG_CONTENT', notAllowed);
      const repaired = await bulk('r5-legacy', { env: { remove: ['OPENCODE_CONFIG_CONTENT'] } });
      assert.equal(repaired.status, 200, repaired.text);
      const saved = JSON.parse(fs.readFileSync(fx.home.roster, 'utf8')).adventurers.find((a) => a.id === 'r5-legacy');
      assert.equal(saved.env, undefined);
    } finally {
      fs.writeFileSync(fx.home.roster, rosterBefore);
    }
  });
});
