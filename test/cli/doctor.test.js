import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runDoctor } from '../../src/cli/doctor.js';
import { homePaths } from '../../src/core/home.js';
import { makeProject, tmpDir } from '../helpers.js';

describe('doctor', () => {
  it('checks lanes: codex script passes, claude script fails with file name, opencode api reachable/unreachable', async () => {
    const { config, write } = makeProject();
    write('tools/codex-run.sh', '#!/bin/bash\nexit 0\n');
    // tools/claude-run.sh is intentionally not created

    const home = homePaths(tmpDir('doc-home-'));
    fs.mkdirSync(home.home, { recursive: true });
    fs.writeFileSync(home.roster, JSON.stringify({ adventurers: [] }));

    // 1) Test with rejecting fetchImpl
    const resultUnreachable = await runDoctor({
      config,
      home,
      fetchImpl: async () => { throw new Error('connection refused'); },
    });

    const codexCheck = resultUnreachable.checks.find((c) => c.name === '通道 codex 脚本');
    assert.ok(codexCheck);
    assert.equal(codexCheck.ok, true);

    const claudeCheck = resultUnreachable.checks.find((c) => c.name === '通道 claude 脚本');
    assert.ok(claudeCheck);
    assert.equal(claudeCheck.ok, false);
    assert.match(claudeCheck.detail, /tools\/claude-run\.sh/);

    const apiCheckUnreachable = resultUnreachable.checks.find((c) => c.name === '通道 opencode API');
    assert.ok(apiCheckUnreachable);
    assert.equal(apiCheckUnreachable.ok, false);
    assert.match(apiCheckUnreachable.detail, /无法连接/);

    // 2) Test with resolving fetchImpl { status: 200 }
    const resultReachable = await runDoctor({
      config,
      home,
      fetchImpl: async () => ({ status: 200 }),
    });

    const apiCheckReachable = resultReachable.checks.find((c) => c.name === '通道 opencode API');
    assert.ok(apiCheckReachable);
    assert.equal(apiCheckReachable.ok, true);
    assert.match(apiCheckReachable.detail, /200/);
  });

  it('checks roster: missing roster fails naming path; cards referencing unknown lanes trigger warning', async () => {
    const { config } = makeProject();
    const missingHome = homePaths(path.join(tmpDir('doc-missing-home-'), 'not-here'));

    const resultMissing = await runDoctor({
      config,
      home: missingHome,
      fetchImpl: async () => ({ status: 200 }),
    });
    const missingCheck = resultMissing.checks.find((c) => c.name === '冒险者名册');
    assert.ok(missingCheck);
    assert.equal(missingCheck.ok, false);
    assert.ok(missingCheck.detail.includes(missingHome.roster));

    // Written roster with a card on lane 'nowhere'
    const home = homePaths(tmpDir('doc-nowhere-home-'));
    fs.mkdirSync(home.home, { recursive: true });
    fs.writeFileSync(home.roster, JSON.stringify({
      adventurers: [
        { id: 'wanderer', name: 'Wanderer', provider: 'Test', lane: 'nowhere', model: 'test-model', family: 'test' },
      ],
    }));

    const resultNowhere = await runDoctor({
      config,
      home,
      fetchImpl: async () => ({ status: 200 }),
    });
    const nowhereCheck = resultNowhere.checks.find((c) => c.name === '冒险者名册');
    assert.ok(nowhereCheck);
    assert.equal(nowhereCheck.ok, false);
    assert.match(nowhereCheck.detail, /nowhere/);
  });

  it('checks board server health: matching project is running, mismatched is conflict, rejecting is not running', async () => {
    const { config } = makeProject();
    const home = homePaths(tmpDir('doc-srv-home-'));
    fs.mkdirSync(home.home, { recursive: true });
    fs.writeFileSync(home.roster, JSON.stringify({ adventurers: [] }));

    // 1) Matching project running
    const resRunning = await runDoctor({
      config,
      home,
      fetchImpl: async (url) => {
        if (url.includes('/api/health')) return { ok: true, project: 'Test Game' };
        return { status: 200 };
      },
    });
    const checkRunning = resRunning.checks.find((c) => c.name === '看板服务');
    assert.ok(checkRunning);
    assert.equal(checkRunning.ok, true);
    assert.match(checkRunning.detail, /看板在跑（Test Game）/);

    // 2) Mismatched project
    const resMismatched = await runDoctor({
      config,
      home,
      fetchImpl: async (url) => {
        if (url.includes('/api/health')) return { ok: true, project: 'Other Project' };
        return { status: 200 };
      },
    });
    const checkMismatched = resMismatched.checks.find((c) => c.name === '看板服务');
    assert.ok(checkMismatched);
    assert.equal(checkMismatched.ok, false);
    assert.match(checkMismatched.detail, /端口被别的项目占用/);

    // 3) Rejecting (nothing answering)
    const resDown = await runDoctor({
      config,
      home,
      fetchImpl: async (url) => {
        if (url.includes('/api/health')) throw new Error('connect ECONNREFUSED');
        return { status: 200 };
      },
    });
    const checkDown = resDown.checks.find((c) => c.name === '看板服务');
    assert.ok(checkDown);
    assert.equal(checkDown.ok, true);
    assert.match(checkDown.detail, /没在跑（questboard serve 可以启动）/);
  });

  it('never leaks secret key values in usage check result', async () => {
    const { config } = makeProject();
    const home = homePaths(tmpDir('doc-key-home-'));
    fs.mkdirSync(home.home, { recursive: true });
    fs.writeFileSync(home.roster, JSON.stringify({ adventurers: [] }));

    const env = { ...process.env, KIMI_API_KEY: 'sk-never-shown' };
    const result = await runDoctor({
      config,
      home,
      env,
      fetchImpl: async () => ({ status: 200 }),
    });

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('sk-never-shown'), false);

    const usageCheck = result.checks.find((c) => c.name === '用量密钥');
    assert.ok(usageCheck);
    assert.match(usageCheck.detail, /KIMI_API_KEY/);
  });
});
