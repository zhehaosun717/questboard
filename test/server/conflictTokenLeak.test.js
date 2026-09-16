// B3 (revision 4): the unknown-brief conflict token (briefs.js's conflictKeys, read by rules.js's
// runningConflict) must never reach a public consumer — the board's snapshot, the CLI's `show`/`get`, or the
// MCP quest tool, all of which read the same GET /api/quests(/:id) the board itself does. Before this fix
// the token was appended straight into quest.files, so it rendered in the drawer of an unrelated finished
// quest as if it were a real allowed file.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixture, tick } from './fixture.js';
import { MAX_BRIEF_BYTES } from '../../src/core/briefs.js';

let fx;
before(async () => { fx = await startFixture(); });
after(() => fx.close());

describe('the unknown-brief conflict token never reaches the public API (B3)', () => {
  it('keeps quest.files and the whole quest object free of the token, snapshot and single-quest endpoints alike', async () => {
    const pad = 'x'.repeat(MAX_BRIEF_BYTES + 1024);
    fx.project.write('docs/briefs/RUN-40-running.md', '# T\n\n## Files you may edit\n- `src/unrelated40.js`\n');
    fx.project.write('docs/briefs/RUN-41-candidate.md', '# T\n\n## Files you may edit\n- `src/candidate41.js`\n');
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'RUN-40', brief: 'docs/briefs/RUN-40-running.md' })).status, 201);
    assert.equal((await fx.api('/api/quests/RUN-40/assign', 'POST', { adventurer: 'codex-luna' })).status, 200);
    await tick(50);
    // RUN-40 turns unknown only after it already holds its slot (exactly the fail-closed scenario this
    // revision protects), never at its own initial dispatch — an oversized brief at drop time is refused
    // for the quest itself (brief_unusable), a different, already-covered path.
    fx.project.write('docs/briefs/RUN-40-running.md', `# T\n\n## Files you may edit\n- \`src/unrelated40.js\`\n${pad}\n`);
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'RUN-41', brief: 'docs/briefs/RUN-41-candidate.md' })).status, 201);

    const snap = (await fx.api('/api/quests')).body;
    const raw = JSON.stringify(snap.quests);
    assert.ok(!raw.includes('unknown-brief'), 'the internal conflict key must never appear anywhere in the public quests array');
    for (const q of snap.quests) {
      assert.ok(!Object.prototype.hasOwnProperty.call(q, 'conflictKeys'), `${q.id} must not expose conflictKeys`);
      assert.ok(!Object.prototype.hasOwnProperty.call(q, 'briefUnknownReason'), `${q.id} must not expose briefUnknownReason`);
    }
    const candidate = snap.quests.find((q) => q.id === 'RUN-41');
    assert.deepEqual(candidate.files, ['src/candidate41.js'], 'the candidate\'s real files must be untouched');

    // The single-quest endpoint the CLI's `show`/`get` and the MCP quest tool both read.
    const single = (await fx.api('/api/quests/RUN-41')).body.quest;
    assert.ok(!JSON.stringify(single).includes('unknown-brief'), 'the single-quest endpoint (CLI/MCP) must not leak the token either');
    assert.ok(!Object.prototype.hasOwnProperty.call(single, 'conflictKeys'));

    // The drawer/CLI-visible RUN-40 itself must also stay clean. Its own files read [] (unknown, not a
    // fabricated real list — briefUnknownReason explains why, but that field itself is never public either).
    const runningSingle = (await fx.api('/api/quests/RUN-40')).body.quest;
    assert.deepEqual(runningSingle.files, []);
    assert.ok(!Object.prototype.hasOwnProperty.call(runningSingle, 'conflictKeys'));
    assert.ok(!Object.prototype.hasOwnProperty.call(runningSingle, 'briefUnknownReason'));
  });
});
