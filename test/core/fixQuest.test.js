// FB2-12 item 4 (with FB2-05): when the delivery self-check fails every round it was allowed, the board
// posts the small fix quest itself — a self-contained brief carrying the check that failed and the error
// text, the failed quest's own editable file set, and origin/check so the card face and the fast-track gate
// can see where it came from. It is never assigned by the board: the coordinator (or the owner) dispatches
// it. A fix that would touch more files than the fast-track limit is never generated — the coordinator gets
// an inbox note instead, naming the files.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { QuestStore } from '../../src/core/store.js';
import { buildFixBrief, pickFixQuestId, planFixQuest, requestFixQuest } from '../../src/core/fixQuest.js';
import { makeProject } from '../helpers.js';

let project;
let store;

const briefWithFiles = (id, files) => `# ${id}\n\n## Files you may edit\n\n${files.map((f) => `- \`${f}\``).join('\n')}\n`;

beforeEach(() => {
  project = makeProject();
  store = new QuestStore(project.config);
});

function failedQuest({ id = 'PX-1', files = ['src/a.js', 'src/b.js'] } = {}) {
  const brief = `docs/briefs/${id}-x.md`;
  project.write(brief, briefWithFiles(id, files));
  store.post({ package: id, brief });
  const assigned = store.assign(id, { adventurer: { id: 'codex-luna', name: 'Luna', lane: 'codex', model: 'm', family: 'f' }, name: `${id.toLowerCase()}_1` });
  return store.setStatus(id, 'failed', {
    detail: '自检连续 2 轮没过，任务失败：\n第 1 轮（exit 0）：FAIL round 1 src/a.js broke',
    by: 'lanes', source: 'collector',
    evidence: { kind: 'collector', attempt: { attemptId: assigned.assignee.attemptId, name: assigned.assignee.name, lane: assigned.assignee.lane, at: assigned.assignee.at } },
  });
}

describe('pickFixQuestId (FB2-12 item 4)', () => {
  it('derives FIX-<failed id>, then a letter suffix, using only ids the project pattern accepts', () => {
    const { config } = project;
    assert.equal(pickFixQuestId(config, 'PX-1', new Set()), 'FIX-PX-1');
    assert.equal(pickFixQuestId(config, 'PX-1', new Set(['FIX-PX-1'])), 'FIX-PX-1B');
    assert.equal(pickFixQuestId(config, 'PX-1', new Set(['FIX-PX-1', 'FIX-PX-1B'])), 'FIX-PX-1C');
  });

  it('returns null when the project pattern cannot express a fix id, never inventing one', () => {
    const { config } = makeProject({ briefs: { packagePattern: '^\\d+$' } });
    assert.equal(pickFixQuestId(config, 'PX-1', new Set()), null);
  });
});

describe('planFixQuest (FB2-12 item 4)', () => {
  it('takes the failed quest\'s own editable files and the check that failed', () => {
    const failed = failedQuest({ files: ['src/a.js', 'src/b.js', 'src/c.js'] });
    const plan = planFixQuest({ config: project.config, failed, checkCommand: 'node scripts/check.js', takenIds: new Set() });
    assert.equal(plan.ok, true);
    assert.equal(plan.id, 'FIX-PX-1');
    assert.deepEqual(plan.files, ['src/a.js', 'src/b.js', 'src/c.js']);
  });

  it('refuses to generate a fix that would touch more files than the fast-track limit', () => {
    const failed = failedQuest({ files: ['a.js', 'b.js', 'c.js', 'd.js'] });
    const plan = planFixQuest({ config: project.config, failed, checkCommand: 'npm test', takenIds: new Set() });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'too_many_files');
    assert.deepEqual(plan.files, ['a.js', 'b.js', 'c.js', 'd.js']);
  });

  it('honours an explicit --files override on the failed quest', () => {
    const brief = 'docs/briefs/PX-2-x.md';
    project.write(brief, briefWithFiles('PX-2', ['src/whole.js']));
    store.post({ package: 'PX-2', brief, files: ['src/one.js'] });
    const plan = planFixQuest({ config: project.config, failed: store.get('PX-2'), checkCommand: 'npm test', takenIds: new Set() });
    assert.deepEqual(plan.files, ['src/one.js']);
  });

  it('says why it cannot generate one instead of picking a random id', () => {
    const { config } = makeProject({ briefs: { packagePattern: '^\\d+$' } });
    const plan = planFixQuest({ config, failed: failedQuest(), checkCommand: 'npm test', takenIds: new Set() });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'no_id');
  });
});

describe('buildFixBrief (FB2-12 item 4)', () => {
  it('names the failed quest, the check, the error text and the files the fix may touch', () => {
    const failed = failedQuest();
    const text = buildFixBrief({
      fixId: 'FIX-PX-1', failed, checkCommand: 'node scripts/check.js', files: ['src/a.js', 'src/b.js'],
    });
    assert.match(text, /FIX-PX-1/);
    assert.match(text, /PX-1/);
    assert.match(text, /node scripts\/check\.js/);
    assert.match(text, /FAIL round 1 src\/a\.js broke/, 'the check\'s own error text is carried into the brief');
    assert.match(text, /docs\/briefs\/PX-1-x\.md/);
    assert.match(text, /`src\/a\.js`/);
  });
});

describe('requestFixQuest (FB2-12 item 4)', () => {
  it('posts the fix quest with origin/check, the file set and a written brief — never assigned', () => {
    const failed = failedQuest();
    const result = requestFixQuest({ config: project.config, store, failedId: 'PX-1', checkCommand: 'node scripts/check.js' });
    assert.equal(result.ok, true, JSON.stringify(result));
    const fix = store.get('FIX-PX-1');
    assert.ok(fix, 'the fix quest is on the board');
    assert.equal(fix.status, 'posted');
    assert.equal(fix.assignee, null, 'never assigned by the board');
    assert.equal(fix.origin, 'post-delivery-check');
    assert.equal(fix.check, 'node scripts/check.js');
    assert.deepEqual(fix.filesOverride, ['src/a.js', 'src/b.js']);
    assert.match(fix.title, /PX-1/);
    assert.equal(fix.postedBy, 'board');
    const briefFile = path.join(project.config.root, fix.brief);
    assert.ok(fs.existsSync(briefFile), `the fix brief exists at ${fix.brief}`);
    assert.match(fs.readFileSync(briefFile, 'utf8'), /node scripts\/check\.js/);
  });

  it('the second failure of the same quest gets the next free id, not an overwrite', () => {
    failedQuest();
    assert.equal(requestFixQuest({ config: project.config, store, failedId: 'PX-1', checkCommand: 'npm test' }).ok, true);
    assert.equal(requestFixQuest({ config: project.config, store, failedId: 'PX-1', checkCommand: 'npm test' }).ok, true);
    assert.ok(store.get('FIX-PX-1'));
    assert.ok(store.get('FIX-PX-1B'));
  });

  it('reports too_many_files without posting anything or writing a brief', () => {
    failedQuest({ files: ['a.js', 'b.js', 'c.js', 'd.js'] });
    const before = store.list().length;
    const result = requestFixQuest({ config: project.config, store, failedId: 'PX-1', checkCommand: 'npm test' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'too_many_files');
    assert.deepEqual(result.files, ['a.js', 'b.js', 'c.js', 'd.js']);
    assert.equal(store.list().length, before, 'nothing was posted');
    assert.equal(fs.existsSync(path.join(project.config.root, 'docs', 'briefs', 'FIX-PX-1-fix.md')), false);
  });

  it('a brief file that already exists is never overwritten: it reports the conflict', () => {
    failedQuest();
    const file = path.join(project.config.root, 'docs', 'briefs', 'FIX-PX-1-fix.md');
    fs.writeFileSync(file, 'somebody else wrote this');
    const result = requestFixQuest({ config: project.config, store, failedId: 'PX-1', checkCommand: 'npm test' });
    assert.equal(result.ok, false);
    assert.match(result.detail, /已经存在/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'somebody else wrote this');
    assert.equal(store.get('FIX-PX-1'), null);
  });

  it('a quest that is not on the board is refused loudly', () => {
    const result = requestFixQuest({ config: project.config, store, failedId: 'GHOST-9', checkCommand: 'npm test' });
    assert.equal(result.ok, false);
    assert.match(result.detail, /GHOST-9/);
  });
});
