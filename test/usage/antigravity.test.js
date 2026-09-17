import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createUsageService } from '../../src/usage/service.js';
import { createAntigravityProvider, decodeUserStatus, findLanguageServer, parsePorts } from '../../src/usage/antigravity.js';
import { UsageError } from '../../src/usage/common.js';
import { tmpDir } from '../helpers.js';

const TOKEN = 'deadbeef-1234-4abc-8def-0123456789ab';
const processList = JSON.stringify([
  { ProcessId: 11, Name: 'other.exe', CommandLine: 'other --csrf_token ffffffff-0000-0000-0000-000000000000' },
  { ProcessId: 4242, Name: 'language_server_windows_x64.exe', CommandLine: `language_server_windows_x64.exe --csrf_token ${TOKEN} --extension_server_port 10745` },
]);
const userStatus = {
  userStatus: {
    planStatus: { planInfo: { planName: 'Pro', monthlyPromptCredits: 1000 }, availablePromptCredits: 640 },
    cascadeModelConfigData: {
      clientModelConfigs: [
        { label: 'Gemini 3 Pro (High)', quotaInfo: { remainingFraction: 0.25, resetTime: '2026-09-14T00:00:00Z' } },
        { label: 'Claude Sonnet 4.5', quotaInfo: { remainingFraction: 1 } },
        { label: `bad ${TOKEN} label`, quotaInfo: { remainingFraction: 0.5 } },
        { label: 'No quota model' },
      ],
    },
  },
};

// exec sees only fixed PowerShell commands; the test answers by which command it was.
const execFor = ({ processes = processList, ports = '10745\n10746\n' } = {}) => async (command, args) => {
  assert.match(command, /powershell\.exe$/i);
  const script = args.at(-1);
  if (script.includes('Get-CimInstance')) return processes;
  if (script.includes('Get-NetTCPConnection')) { assert.match(script, /OwningProcess 4242/); return ports; }
  throw new Error(`unexpected command ${script}`);
};

describe('antigravity provider', () => {
  it('parses the process list and the port list', () => {
    assert.deepEqual(findLanguageServer(processList), { pid: 4242, token: TOKEN });
    assert.equal(findLanguageServer('[]'), null);
    assert.equal(findLanguageServer('not json'), null);
    assert.deepEqual(findLanguageServer(JSON.stringify({ ProcessId: 7, Name: 'language_server_windows_x64.exe', CommandLine: `x --csrf_token=${TOKEN}` })), { pid: 7, token: TOKEN });
    assert.deepEqual(parsePorts('10745\r\n10746\r\n\r\n'), [10745, 10746]);
    assert.deepEqual(parsePorts(''), []);
  });

  it('decodes quotas as used percent, keeps only clean labels, and summarises the plan', () => {
    const decoded = decodeUserStatus(userStatus);
    assert.deepEqual(decoded.windows, [
      { label: 'Gemini 3 Pro (High)', usedPercent: 75, resetsAt: '2026-09-14T00:00:00.000Z' },
      { label: 'Claude Sonnet 4.5', usedPercent: 0, resetsAt: null },
    ]);
    assert.equal(decoded.plan, 'Pro · 额度 640 / 1000');
    assert.throws(() => decodeUserStatus({ message: 'nope' }), UsageError);
  });

  it('sends the token only as a header to the found port and never lets it into the report', async () => {
    const posts = [];
    const post = async (port, body, headers) => {
      posts.push({ port, headers });
      if (port === 10745) throw new UsageError('连不上本机 Antigravity 服务');
      assert.equal(body.metadata.ideName, 'antigravity');
      return userStatus;
    };
    const provider = createAntigravityProvider({ post, platform: 'win32' });
    const report = await createUsageService({ homedir: tmpDir('qb-agy-'), env: {}, exec: execFor(), providers: [provider] }).report();
    const [agy] = report.providers;
    assert.equal(agy.ok, true, agy.error);
    assert.equal(agy.windows.length, 2);
    assert.deepEqual(posts.map((p) => p.port), [10745, 10746], 'tries the next port when one refuses');
    assert.equal(posts[0].headers['x-codeium-csrf-token'], TOKEN);
    assert.ok(!JSON.stringify(report).includes(TOKEN));
  });

  it('says plainly when the app is not running, when no port answers, and on other platforms', async () => {
    const none = createAntigravityProvider({ post: async () => userStatus, platform: 'win32' });
    const [notRunning] = (await createUsageService({ homedir: tmpDir('qb-agy-'), env: {}, exec: execFor({ processes: '[]' }), providers: [none] }).report()).providers;
    assert.equal(notRunning.configured, false);
    assert.match(notRunning.error, /没在跑/);

    const deaf = createAntigravityProvider({ post: async () => { throw new Error(`socket ${TOKEN}`); }, platform: 'win32' });
    const [noAnswer] = (await createUsageService({ homedir: tmpDir('qb-agy-'), env: {}, exec: execFor(), providers: [deaf] }).report()).providers;
    assert.equal(noAnswer.ok, false);
    assert.equal(noAnswer.error, '连不上本机 Antigravity 服务');
    assert.ok(!JSON.stringify(noAnswer).includes(TOKEN));

    const mac = createAntigravityProvider({ post: async () => userStatus, platform: 'darwin' });
    const [unsupported] = (await createUsageService({ homedir: tmpDir('qb-agy-'), env: {}, exec: execFor(), providers: [mac] }).report()).providers;
    assert.equal(unsupported.configured, false);
    assert.match(unsupported.error, /Windows/);
  });
});
