// Project identity in the snapshot (QB-FB-BG): the board namespaces browser storage by a stable, opaque
// id digested from the canonical project root, so two same-named projects on one port cannot collide,
// and the root path itself never travels to the browser.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { projectId, buildSnapshot } from '../../src/core/snapshot.js';
import { QuestStore } from '../../src/core/store.js';
import { effectiveRoster } from '../../src/core/overlay.js';
import { makeProject } from '../helpers.js';

describe('snapshot project identity', () => {
  it('carries the id through buildSnapshot, beside name and lanes', () => {
    const { config } = makeProject();
    const snapshot = buildSnapshot({ config, store: new QuestStore(config), adventurers: [], boardStore: null, lanes: { packages: [] } });
    assert.equal(snapshot.project.id, projectId(config.root), 'the snapshot id is the root digest');
    assert.equal(snapshot.project.name, config.name, 'the name is still there, for display only');
  });

  it('is the same id for the same root, built twice', () => {
    const a = projectId('E:/Projects/Game');
    const b = projectId('E:/Projects/Game');
    assert.equal(a, b, 'the id must survive server restarts, or saved layout drifts');
  });

  it('differs for two same-named projects rooted in different folders', () => {
    // Same name, different roots: the only thing the fold key can trust is the digest.
    assert.notEqual(projectId('E:/one/game'), projectId('E:/two/game'));
  });

  it('is a short lowercase hex digest that does not reveal the root', () => {
    const root = 'E:/secret-projects/fixture-project';
    const id = projectId(root);
    assert.match(id, /^[0-9a-f]{12}$/, 'opaque 12-hex digest');
    assert.ok(!id.includes('fixture') && !id.includes('secret'), 'the raw root must not leak');
  });

  it('ignores trailing separators and repeated slashes in the root', () => {
    assert.equal(projectId('E:/Projects/Game/'), projectId('E:/Projects/Game'));
    assert.equal(projectId('E:/Projects//Game'), projectId('E:/Projects/Game'));
  });

  it('folds case and separators only where the filesystem does (Windows)', () => {
    const onWindows = path.sep === '\\';
    const same = projectId('E:/Projects/Game') === projectId('e:/projects/game');
    assert.equal(same, onWindows, 'Windows paths are case-insensitive; POSIX paths are not');
    if (onWindows) {
      assert.equal(projectId('E:\\Projects\\Game'), projectId('E:/Projects/Game'), 'separators canonicalize on Windows');
    }
  });

  it('names a missing root instead of inventing an id', () => {
    assert.throws(() => projectId(''), /根目录/);
    assert.throws(() => projectId(undefined), /根目录/);
  });
});

describe('snapshot roster neverDelivered (FB2-07 item 5)', () => {
  it('marks cards that never delivered anything; a delivered attempt clears the mark', () => {
    const { config, write } = makeProject();
    write('docs/briefs/ND-1-x.md', '# ND-1');
    const store = new QuestStore(config);
    store.post({ package: 'ND-1', brief: 'docs/briefs/ND-1-x.md' });
    store.assign('ND-1', { adventurer: { id: 'codex-luna', lane: 'codex', model: 'm', family: 'f', name: 'Luna' }, name: 'nd1' });
    const adventurers = [
      { id: 'codex-luna', name: 'Luna', provider: 'p', model: 'm', family: 'f', lane: 'codex', importedFrom: 'opencode' },
      { id: 'fresh-card', name: 'Fresh', provider: 'p', model: 'm2', family: 'f', lane: 'codex', importedFrom: 'opencode' },
    ];
    const before = buildSnapshot({ config, store, adventurers, boardStore: null, lanes: { packages: [] } });
    assert.equal(before.roster.find((c) => c.id === 'codex-luna').neverDelivered, true, 'dispatched but not yet delivered');
    assert.equal(before.roster.find((c) => c.id === 'fresh-card').neverDelivered, true);
    store.setStatus('ND-1', 'delivered', { detail: 'done', by: 'lanes', ack: true });
    const after = buildSnapshot({ config, store, adventurers, boardStore: null, lanes: { packages: [] } });
    assert.equal(after.roster.find((c) => c.id === 'codex-luna').neverDelivered, false);
    assert.equal(after.roster.find((c) => c.id === 'fresh-card').neverDelivered, true, 'untouched card still unproven');
  });
});
