// A brand-new machine has no roster. The board must still open (so the first card can be added from the
// 冒险者 tab), and `roster init` must create one without needing a first-generation roster to import.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../../src/server/server.js';
import { commands } from '../../src/cli/commands.js';
import { loadRoster, loadRosterOrEmpty } from '../../src/core/roster.js';
import { makeProject, tmpDir } from '../helpers.js';

const freshHome = () => {
  const dir = tmpDir('qb-fresh-home-');
  return { home: dir, roster: path.join(dir, 'roster.json'), status: path.join(dir, 'status.jsonl') };
};

describe('a machine with no roster yet', () => {
  it('reads as empty, but a malformed roster still fails loudly', () => {
    const home = freshHome();
    assert.deepEqual(loadRosterOrEmpty(home.roster), { adventurers: [] });
    fs.writeFileSync(home.roster, '{"adventurers": "not a list"}');
    assert.throws(() => loadRosterOrEmpty(home.roster), /adventurers array is required/);
  });

  it('opens the board with no cards instead of refusing every request', async () => {
    const { config } = makeProject();
    const home = freshHome();
    const server = createServer({ config, home, getLanes: () => null });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await fetch(`${base}/api/quests`);
      assert.equal(response.status, 200);
      const snapshot = await response.json();
      assert.deepEqual(snapshot.roster, []);
      assert.deepEqual((await (await fetch(`${base}/api/roster`)).json()).adventurers, []);

      // The first card can then be added through the board itself.
      const added = await fetch(`${base}/api/roster`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ adventurer: { id: 'first-card', name: 'First', provider: 'Someone', lane: 'codex', model: 'a-model', family: 'a-model' } }),
      });
      assert.equal(added.status, 200);
      assert.deepEqual(loadRoster(home.roster).adventurers.map((a) => a.id), ['first-card']);
      assert.deepEqual((await (await fetch(`${base}/api/quests`)).json()).roster.map((a) => a.status), ['available']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('creates an empty roster with `roster init`, and refuses to overwrite one without --force', async () => {
    const home = freshHome();
    const previous = process.env.QUESTBOARD_HOME;
    process.env.QUESTBOARD_HOME = home.home;
    try {
      await commands.roster(['init']);
      assert.deepEqual(loadRoster(home.roster), { adventurers: [] });
      await assert.rejects(commands.roster(['init']), /exists/);
      fs.writeFileSync(home.roster, JSON.stringify({ adventurers: [{ id: 'keep-me', name: 'K', provider: 'P', lane: 'codex', model: 'm', family: 'm' }] }));
      await assert.rejects(commands.roster(['init']), /exists/, 'an existing roster is never silently replaced');
      await commands.roster(['init', '--force']);
      assert.deepEqual(loadRoster(home.roster).adventurers, []);
    } finally {
      if (previous === undefined) delete process.env.QUESTBOARD_HOME; else process.env.QUESTBOARD_HOME = previous;
    }
  });
});
