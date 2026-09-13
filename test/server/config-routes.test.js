import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startFixture } from './fixture.js';
import { tmpDir } from '../helpers.js';
import { loadRoster } from '../../src/core/roster.js';
import { parseModelList, readOmo, saveOmo, stripJsonc, validateOmoItems } from '../../src/integrations/omo.js';
import { createOmoRoutes } from '../../src/server/omoRoutes.js';
import { createSettingsRoutes } from '../../src/server/settingsRoutes.js';
import { routeParts } from '../../src/server/http.js';

let fx;
before(async () => { fx = await startFixture(); });
after(() => fx.close());

const NEW_CARD = { id: 'glm-coder', name: 'GLM', provider: 'Zhipu', lane: 'opencode', model: 'zhipu/glm-5', family: 'glm-5', maxParallel: 1, strengths: ['code'] };

describe('roster writes', () => {
  it('adds and replaces a card, refusing status fields and unknown lanes', async () => {
    assert.equal((await fx.api('/api/roster', 'POST', { adventurer: NEW_CARD })).status, 200);
    assert.equal((await fx.api('/api/roster', 'POST', { adventurer: { ...NEW_CARD, name: 'GLM 5' } })).body.adventurer.name, 'GLM 5');
    assert.equal(loadRoster(fx.home.roster).adventurers.filter((a) => a.id === 'glm-coder').length, 1);
    const withStatus = await fx.api('/api/roster', 'POST', { adventurer: { ...NEW_CARD, status: 'paused' } });
    assert.equal(withStatus.status, 400);
    assert.match(withStatus.body.error, /status field/);
    assert.equal((await fx.api('/api/roster', 'POST', { adventurer: { ...NEW_CARD, lane: 'nowhere' } })).status, 400);
    assert.equal((await fx.api('/api/roster', 'POST', { adventurer: { ...NEW_CARD, lane: 'constructor' } })).status, 400, 'an object prototype key is not a lane');
    assert.equal((await fx.api('/api/roster', 'POST', { adventurer: NEW_CARD }, { origin: 'http://evil.example' })).status, 403);
  });

  it('removes a card, but not one that is working on a quest', async () => {
    assert.equal((await fx.api('/api/roster/glm-coder/delete', 'POST', {})).status, 200);
    assert.ok(!loadRoster(fx.home.roster).adventurers.some((a) => a.id === 'glm-coder'));
    assert.equal((await fx.api('/api/roster/glm-coder/delete', 'POST', {})).status, 404);
    const posted = fx.server.store.post({ package: 'RUN-4', kind: 'code', brief: 'docs/briefs/RUN-4-the-way-back.md', title: 'the way back' });
    assert.ok(!posted.errors, JSON.stringify(posted.errors));
    const assigned = await fx.api('/api/quests/RUN-4/assign', 'POST', { adventurer: 'codex-luna' });
    assert.equal(assigned.status, 200, assigned.text);
    const refused = await fx.api('/api/roster/codex-luna/delete', 'POST', {});
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /RUN-4/);
  });
});

describe('OMO model assignments', () => {
  const sample = `// OMO configuration
{
  "$schema": "https://example.test/schema.json",
  "[opencode]": {
    "agents": { "oracle": { "model": "openai/gpt-5.6-luna", "reasoning": "high", "extra": 1 }, }, // trailing comma
    /* block */ "categories": { "quick": { "model": "deepseek/deepseek-v4" } }
  }
}`;

  it('reads JSONC, saves changes with a backup, keeps other keys, and removes emptied entries', () => {
    const dir = tmpDir('qb-omo-');
    const file = path.join(dir, 'omo.jsonc');
    fs.writeFileSync(file, sample);
    assert.equal(JSON.parse(stripJsonc('{"a":"// not a comment",}')).a, '// not a comment');
    assert.deepEqual(JSON.parse(stripJsonc('{"x": ",}", "y": [1, /* c */ 2,], } // end')), { x: ',}', y: [1, 2] });
    const before = readOmo(file);
    assert.deepEqual(before.agents, [{ name: 'oracle', model: 'openai/gpt-5.6-luna', reasoning: 'high' }]);
    const after = saveOmo(file, [
      { section: 'agents', name: 'oracle', model: 'openai/gpt-6-astra', reasoning: 'xhigh' },
      { section: 'categories', name: 'quick', model: '', reasoning: '' },
      { section: 'categories', name: 'writing', model: 'kimi/k3', reasoning: '' },
    ], { now: Date.parse('2026-09-13T10:00:00Z') });
    assert.deepEqual(after.agents, [{ name: 'oracle', model: 'openai/gpt-6-astra', reasoning: 'xhigh' }]);
    assert.deepEqual(after.categories.map((c) => c.name), ['writing']);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.$schema, 'https://example.test/schema.json');
    assert.equal(saved['[opencode]'].agents.oracle.extra, 1);
    assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('omo.jsonc.bak-')));
    assert.equal(readOmo(path.join(dir, 'missing.jsonc')).available, false);
  });

  it('validates changes and parses the model list', () => {
    assert.match(validateOmoItems([{ section: 'tools', name: 'x', model: '', reasoning: '' }]), /section/);
    assert.match(validateOmoItems([{ section: 'agents', name: 'oracle', model: 'no-slash', reasoning: '' }]), /provider\/model/);
    assert.match(validateOmoItems([{ section: 'agents', name: 'oracle', model: 'a/b', reasoning: 'turbo' }]), /reasoning/);
    assert.deepEqual(parseModelList('Available models:\nopenai/gpt-5.6-luna\r\n  deepseek/deepseek-v4 \nopenai/gpt-5.6-luna\nnot a model\nhttps://example.test/path?token=abc\nweird/`rm -rf`'), ['openai/gpt-5.6-luna', 'deepseek/deepseek-v4']);
  });
});

async function serve(routes, requests) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!(await routes.handle(req, res, url, routeParts(url.pathname)))) { res.writeHead(599); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await requests(async (route, init = {}) => {
      const response = await fetch(base + route, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
      return { status: response.status, body: await response.json().catch(() => null) };
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('OMO and settings routes', () => {
  it('serves and saves OMO, caches the model list, and refuses cross-site saves', async () => {
    const file = path.join(tmpDir('qb-omo-route-'), 'omo.jsonc');
    fs.writeFileSync(file, '{"[opencode]":{"agents":{"oracle":{"model":"a/b"}},"categories":{}}}');
    let runs = 0;
    const routes = createOmoRoutes({ file, exec: async () => { runs += 1; return 'a/b\nc/d\n'; } });
    await serve(routes, async (call) => {
      assert.equal((await call('/api/omo')).body.agents[0].model, 'a/b');
      const saved = await call('/api/omo', { method: 'POST', body: JSON.stringify({ items: [{ section: 'agents', name: 'oracle', model: 'c/d', reasoning: 'high' }] }) });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.agents[0].reasoning, 'high');
      assert.equal((await call('/api/omo', { method: 'POST', headers: { origin: 'http://evil.example' }, body: '{}' })).status, 403);
      assert.equal((await call('/api/omo', { method: 'POST', body: JSON.stringify({ items: [] }) })).status, 400);
      assert.deepEqual((await call('/api/omo/models')).body.models, ['a/b', 'c/d']);
      await call('/api/omo/models');
      assert.equal(runs, 1);
      assert.equal((await call('/api/omo/models?refresh=1', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'another site cannot start the CLI');
      assert.equal(runs, 1);
      await call('/api/omo/models?refresh=1');
      assert.equal(runs, 2);
    });
  });

  it('saves the whole config only when it would still load, keeping a backup', async () => {
    const routes = createSettingsRoutes({ config: fx.project.config, home: fx.home });
    const file = path.join(fx.project.root, 'questboard.config.json');
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    try {
      await serve(routes, async (call) => {
        const before = await call('/api/settings');
        assert.equal(before.body.raw.name, 'Test Game', 'the page edits the file as written, not the resolved view');

        const edited = { ...original, policy: { ...original.policy, bannedAgents: ['Sisyphus', 'Momus'] } };
        const saved = await call('/api/settings', { method: 'POST', body: JSON.stringify({ raw: edited }) });
        assert.equal(saved.status, 200, saved.body && saved.body.error);
        assert.equal(saved.body.restartRequired, true, 'the running server captured its config at startup');
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).policy.bannedAgents, ['Sisyphus', 'Momus']);
        assert.ok(fs.readdirSync(fx.project.root).some((name) => name.startsWith('questboard.config.json.bak-')), 'the previous file is kept');

        const broken = await call('/api/settings', { method: 'POST', body: JSON.stringify({ raw: { ...original, lanes: {} } }) });
        assert.equal(broken.status, 400);
        assert.match(broken.body.error, /lanes/);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).policy.bannedAgents, ['Sisyphus', 'Momus'], 'a refused save changes nothing on disk');

        assert.equal((await call('/api/settings', { method: 'POST', headers: { origin: 'http://evil.example' }, body: '{}' })).status, 403);
        assert.equal((await call('/api/settings', { method: 'POST', body: JSON.stringify({ raw: 'not an object' }) })).status, 400);
      });
    } finally {
      fs.writeFileSync(file, `${JSON.stringify(original, null, 2)}\n`);
    }
  });

  it('describes the project and says which key sources exist without returning keys', async () => {
    const homedir = tmpDir('qb-settings-home-');
    fs.mkdirSync(path.join(homedir, '.local', 'share', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(homedir, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({ deepseek: { type: 'api', key: 'sk-never-shown' } }));
    const routes = createSettingsRoutes({ config: fx.project.config, home: fx.home, env: { KIMI_API_KEY: 'kimi-never-shown' }, homedir, omoFile: path.join(homedir, 'omo.jsonc') });
    await serve(routes, async (call) => {
      const { status, body } = await call('/api/settings');
      assert.equal(status, 200);
      assert.equal(body.project.name, 'Test Game');
      assert.ok(body.project.lanes.some((lane) => lane.id === 'codex' && Array.isArray(lane.run)));
      const sources = Object.fromEntries(body.usageKeys.map((k) => [k.id, k.sources]));
      assert.deepEqual(sources.kimi.find((s) => s.kind === 'env'), { kind: 'env', name: 'KIMI_API_KEY', present: true });
      assert.equal(sources.deepseek.find((s) => s.kind === 'opencode').present, true);
      assert.equal(body.omo.exists, false);
      const text = JSON.stringify(body);
      assert.ok(!text.includes('never-shown'));
    });
  });
});
