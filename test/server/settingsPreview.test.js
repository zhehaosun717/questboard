import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { resolveConfig } from '../../src/core/config.js';
import { routeParts } from '../../src/server/http.js';
import { createSettingsRoutes, describeProject, previewLaneCommand } from '../../src/server/settingsRoutes.js';
import { tmpDir } from '../helpers.js';
import { listenOnSafePort } from './fixture.js';

async function serve(routes, requests) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!(await routes.handle(req, res, url, routeParts(url.pathname)))) {
      res.writeHead(599);
      res.end();
    }
  });
  // Same guard as test/server/fixture.js's listenOnSafePort: a listen(0) ephemeral port can land on the
  // WHATWG Fetch "bad port" list (already the confirmed cause of one flaky MCP stdio run and suspected in
  // an annotation-origin run — see fetchBlockedPorts.test.js) — the server is up, but fetch() throws
  // "fetch failed" / 'bad port'. This file used to bind with a raw server.listen(0, ...) and was the one
  // place left without the retry.
  const { port } = await listenOnSafePort(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    return await requests(async (route, init = {}) => {
      const response = await fetch(base + route, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers || {}) },
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('describeProject optionalArgs support', () => {
  it('exposes optionalArgs as an empty array when unconfigured', () => {
    const root = tmpDir('qb-desc-proj-');
    const config = resolveConfig(root, {
      name: 'Test',
      lanes: {
        plain: { run: ['node', 'worker.js'], outputDir: 'out' },
      },
    });
    const described = describeProject(config);
    assert.equal(described.lanes.length, 1);
    assert.deepEqual(described.lanes[0].optionalArgs, []);
  });

  it('exposes optionalArgs exactly as configured', () => {
    const root = tmpDir('qb-desc-proj-');
    const raw = {
      name: 'Test',
      lanes: {
        opt: {
          run: ['node', 'worker.js'],
          outputDir: 'out',
          optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'] }],
        },
      },
    };
    fs.writeFileSync(path.join(root, 'questboard.config.json'), JSON.stringify(raw), 'utf8');
    const config = resolveConfig(root, raw);
    const described = describeProject(config);
    assert.equal(described.lanes.length, 1);
    assert.deepEqual(described.lanes[0].optionalArgs, [{ when: 'variant', args: ['--effort', '{variant}'] }]);
  });
});

describe('POST /api/settings/lanes/preview endpoint', () => {
  const root = tmpDir('qb-preview-route-');
  const config = resolveConfig(root, {
    name: 'PreviewProj',
    lanes: {
      'default-lane': { run: ['node', 'worker.js'], outputDir: 'out' },
  },
});
fs.writeFileSync(path.join(root, 'worker.js'), '', 'utf8');
fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(root, 'scripts', 'run.mjs'), '', 'utf8');
const home = { home: root, roster: path.join(root, 'roster.json'), status: path.join(root, 'status.jsonl') };

  it('refuses cross-site calls with 403', async () => {
    const routes = createSettingsRoutes({ config, home });
    await serve(routes, async (call) => {
      const res = await call('/api/settings/lanes/preview', {
        method: 'POST',
        headers: { origin: 'http://evil.example' },
        body: JSON.stringify({ lane: { run: ['node', 'x.js'] } }),
      });
      assert.equal(res.status, 403);
    });
  });

  it('returns the router-shaped 404 only for an unknown preview route', async () => {
    const routes = createSettingsRoutes({ config, home });
    await serve(routes, async (call) => {
      const res = await call('/api/settings/lanes/unknown-preview-route', { method: 'GET' });
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, { error: 'not found' });
    });
  });

  it('validates lane and returns 400 with field errors when invalid', async () => {
    const routes = createSettingsRoutes({ config, home });
    await serve(routes, async (call) => {
      // Missing lane object
      const missingLane = await call('/api/settings/lanes/preview', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      assert.equal(missingLane.status, 400);
      assert.ok(missingLane.body.fields);

      // Invalid optionalArgs: when is unknown
      const badWhen = await call('/api/settings/lanes/preview', {
        method: 'POST',
        body: JSON.stringify({
          lane: {
            id: 'my-lane',
            run: ['node', 'worker.js'],
            outputDir: 'out',
            optionalArgs: [
              { when: 'unknown_when', args: ['--flag', '{unknown_when}'], insertAt: 2 },
            ],
          },
        }),
      });
      assert.equal(badWhen.status, 400);
      assert.ok(badWhen.body.error.includes('must be one of variant|agent'));
      assert.ok(badWhen.body.fields);

      // Overlap: run still requires placeholder
      const overlap = await call('/api/settings/lanes/preview', {
        method: 'POST',
        body: JSON.stringify({
          lane: {
            id: 'overlap-lane',
            run: ['node', 'worker.js', '{variant}'],
            outputDir: 'out',
            optionalArgs: [
              { when: 'variant', args: ['--effort', '{variant}'], insertAt: 2 },
            ],
          },
        }),
      });
      assert.equal(overlap.status, 400);
      assert.ok(overlap.body.error.includes('cannot be both required and optional'));
      assert.ok(overlap.body.fields);

      // Out of range insertAt
      const badInsert = await call('/api/settings/lanes/preview', {
        method: 'POST',
        body: JSON.stringify({
          lane: {
            id: 'bad-insert',
            run: ['node', 'worker.js'],
            outputDir: 'out',
            optionalArgs: [
              { when: 'variant', args: ['--effort', '{variant}'], insertAt: 1 },
            ],
          },
        }),
      });
      assert.equal(badInsert.status, 400);
      assert.ok(badInsert.body.error.includes('insertAt'));
    });
  });

  it('inserts optional arguments when condition matches', async () => {
    const routes = createSettingsRoutes({ config, home });
    await serve(routes, async (call) => {
      const res = await call('/api/settings/lanes/preview', {
        method: 'POST',
        body: JSON.stringify({
          lane: {
            id: 'effort-lane',
            run: ['node', 'worker.js', '--task', '{package}'],
            outputDir: 'out',
            optionalArgs: [
              { when: 'variant', args: ['--effort', '{variant}'], omitWhen: ['none'], insertAt: 2 },
            ],
          },
          card: { model: 'claude-3-7-sonnet', variant: 'high', agent: 'coder' },
          sample: { name: 'w-1', brief: 'docs/b.md', package: 'TASK-1' },
        }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.omitted, []);
      assert.deepEqual(res.body.warnings, []);
      // node resolved to process.execPath, then worker.js, then inserted args at pos 2, then --task, TASK-1
      assert.equal(res.body.argv[0], process.execPath);
      assert.equal(res.body.argv[1], 'worker.js');
      assert.equal(res.body.argv[2], '--effort');
      assert.equal(res.body.argv[3], 'high');
      assert.equal(res.body.argv[4], '--task');
      assert.equal(res.body.argv[5], 'TASK-1');
    });
  });

  it('omits group atomically when variant is absent or matches omitWhen', async () => {
    const routes = createSettingsRoutes({ config, home });
    await serve(routes, async (call) => {
      // 1. Variant absent (empty string)
      const absentRes = await call('/api/settings/lanes/preview', {
        method: 'POST',
        body: JSON.stringify({
          lane: {
            id: 'effort-lane',
            run: ['node', 'worker.js', '--task', '{package}'],
            outputDir: 'out',
            optionalArgs: [
              { when: 'variant', args: ['--effort', '{variant}'], omitWhen: ['none', 'off'], insertAt: 2 },
            ],
          },
          card: { model: 'claude-3-7-sonnet', variant: '' },
          sample: { package: 'TASK-1' },
        }),
      });
      assert.equal(absentRes.status, 200);
      assert.equal(absentRes.body.omitted.length, 1);
      assert.equal(absentRes.body.omitted[0].when, 'variant');
      assert.equal(absentRes.body.omitted[0].reason, 'absent');
      // Neither --effort nor {variant} is in argv
      assert.ok(!absentRes.body.argv.includes('--effort'));
      assert.equal(absentRes.body.argv[1], 'worker.js');
      assert.equal(absentRes.body.argv[2], '--task');
      assert.equal(absentRes.body.argv[3], 'TASK-1');

      // 2. Variant in omitWhen ('none')
      const omitNoneRes = await call('/api/settings/lanes/preview', {
        method: 'POST',
        body: JSON.stringify({
          lane: {
            id: 'effort-lane',
            run: ['node', 'worker.js', '--task', '{package}'],
            outputDir: 'out',
            optionalArgs: [
              { when: 'variant', args: ['--effort', '{variant}'], omitWhen: ['none', 'off'], insertAt: 2 },
            ],
          },
          card: { model: 'claude-3-7-sonnet', variant: 'none' },
          sample: { package: 'TASK-1' },
        }),
      });
      assert.equal(omitNoneRes.status, 200);
      assert.equal(omitNoneRes.body.omitted.length, 1);
      assert.equal(omitNoneRes.body.omitted[0].when, 'variant');
      assert.ok(omitNoneRes.body.omitted[0].reason.includes('omitWhen'));
      assert.ok(!omitNoneRes.body.argv.includes('--effort'));

      // 3. Variant in omitWhen ('off')
      const omitOffRes = await call('/api/settings/lanes/preview', {
        method: 'POST',
        body: JSON.stringify({
          lane: {
            id: 'effort-lane',
            run: ['node', 'worker.js', '--task', '{package}'],
            outputDir: 'out',
            optionalArgs: [
              { when: 'variant', args: ['--effort', '{variant}'], omitWhen: ['none', 'off'], insertAt: 2 },
            ],
          },
          card: { model: 'claude-3-7-sonnet', variant: 'off' },
          sample: { package: 'TASK-1' },
        }),
      });
      assert.equal(omitOffRes.status, 200);
      assert.equal(omitOffRes.body.omitted.length, 1);
      assert.equal(omitOffRes.body.omitted[0].when, 'variant');
      assert.ok(omitOffRes.body.omitted[0].reason.includes('off'));
    });
  });

  it('preserves exact arguments with spaces and quotes and does not leak env secrets', async () => {
    const routes = createSettingsRoutes({ config, home });
    await serve(routes, async (call) => {
      const res = await call('/api/settings/lanes/preview', {
        method: 'POST',
        body: JSON.stringify({
          lane: {
            id: 'spaced-lane',
            run: ['codex', 'run', '--prompt', 'hello world with spaces', '{model}'],
            outputDir: 'out',
            env: { SECRET_KEY: 'super-secret-token' },
            optionalArgs: [
              { when: 'agent', args: ['--agent-opt', 'quoted "string" value {agent}'], insertAt: 2 },
            ],
          },
          card: { model: 'gpt-4o', agent: 'oracle analyst' },
        }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.argv[0], 'codex');
      assert.equal(res.body.argv[1], 'run');
      assert.equal(res.body.argv[2], '--agent-opt');
      assert.equal(res.body.argv[3], 'quoted "string" value oracle analyst');
      assert.equal(res.body.argv[4], '--prompt');
      assert.equal(res.body.argv[5], 'hello world with spaces');
      assert.equal(res.body.argv[6], 'gpt-4o');

      // Ensure secret is nowhere in response JSON
      const jsonText = JSON.stringify(res.body);
      assert.ok(!jsonText.includes('super-secret-token'));
    });
  });

  it('warns when legacy positional {variant} is directly in run', async () => {
    const routes = createSettingsRoutes({ config, home });
    await serve(routes, async (call) => {
      const res = await call('/api/settings/lanes/preview', {
        method: 'POST',
        body: JSON.stringify({
          lane: {
            id: 'legacy-lane',
            run: ['node', 'scripts/run.mjs', '{model}', '{variant}', '{package}'],
            outputDir: 'out',
          },
          card: { model: 'claude-3-5-sonnet', variant: 'high' },
          sample: { package: 'LEGACY-1' },
        }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.warnings.length, 1);
      assert.ok(res.body.warnings[0].includes('{variant}'));
      assert.ok(res.body.warnings[0].includes('无法按需省略'));
      assert.equal(res.body.argv[3], 'high');

      // The real planner refuses the same missing required value as dispatch; preview never invents a slot.
      const emptyVariantRes = await call('/api/settings/lanes/preview', {
        method: 'POST',
        body: JSON.stringify({
          lane: {
            id: 'legacy-lane',
            run: ['node', 'scripts/run.mjs', '{model}', '{variant}', '{package}'],
            outputDir: 'out',
          },
          card: { model: 'claude-3-5-sonnet', variant: '' },
          sample: { package: 'LEGACY-1' },
        }),
      });
      assert.equal(emptyVariantRes.status, 400);
      assert.match(emptyVariantRes.body.error, /needs \{variant\}/);
      assert.equal(emptyVariantRes.body.argv, undefined);
    });
  });

  it('refuses missing required card values and validates every lane planning surface', async () => {
    const routes = createSettingsRoutes({ config, home });
    await serve(routes, async (call) => {
      const missingModel = await call('/api/settings/lanes/preview', {
        method: 'POST',
        body: JSON.stringify({
          lane: { id: 'model-lane', run: ['node', 'worker.js', '{model}'], outputDir: 'out' },
          card: { variant: 'high' },
          sample: { name: 'w-1', brief: 'docs/b.md', package: 'TASK-1' },
        }),
      });
      assert.equal(missingModel.status, 400);
      assert.match(missingModel.body.error, /needs \{model\}/);
      assert.equal(missingModel.body.argv, undefined);

      const missingAgent = await call('/api/settings/lanes/preview', {
        method: 'POST',
        body: JSON.stringify({
          lane: { id: 'agent-lane', run: ['node', 'worker.js', '{agent}'], outputDir: 'out' },
          card: { model: 'gpt-4o' },
          sample: { name: 'w-1', brief: 'docs/b.md', package: 'TASK-1' },
        }),
      });
      assert.equal(missingAgent.status, 400);
      assert.match(missingAgent.body.error, /needs \{agent\}/);

      const missingOutputDir = await call('/api/settings/lanes/preview', {
        method: 'POST',
        body: JSON.stringify({
          lane: { id: 'missing-output', run: ['node', 'worker.js'] },
          card: { model: 'gpt-4o' },
          sample: { name: 'w-1', brief: 'docs/b.md', package: 'TASK-1' },
        }),
      });
      assert.equal(missingOutputDir.status, 400);
      assert.match(missingOutputDir.body.error, /outputDir/);

      const envOverlap = await call('/api/settings/lanes/preview', {
        method: 'POST',
        body: JSON.stringify({
          lane: {
            id: 'env-overlap',
            run: ['node', 'worker.js'],
            outputDir: 'out',
            env: { MODEL_VALUE: '{variant}' },
            optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}'], insertAt: 2 }],
          },
          card: { model: 'gpt-4o' },
          sample: { name: 'w-1', brief: 'docs/b.md', package: 'TASK-1' },
        }),
      });
      assert.equal(envOverlap.status, 400);
      assert.match(envOverlap.body.error, /cannot be both required and optional/);
    });
  });

  it('refuses empty optional arguments instead of previewing or saving them', async () => {
    const routes = createSettingsRoutes({ config, home });
    await serve(routes, async (call) => {
      const res = await call('/api/settings/lanes/preview', {
        method: 'POST',
        body: JSON.stringify({
          lane: {
            id: 'blank-optional',
            run: ['node', 'worker.js'],
            outputDir: 'out',
            optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}', ''], insertAt: 2 }],
          },
          card: { model: 'gpt-4o', variant: 'high' },
          sample: { name: 'w-1', brief: 'docs/b.md', package: 'TASK-1' },
        }),
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /empty or whitespace-only/);
      assert.ok(res.body.fields['optionalArgs[0].args']);
    });
  });
});
