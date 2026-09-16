import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { makeProject, quest } from '../helpers.js';
import { planDispatch } from '../../src/core/dispatch.js';
import { renderRoleCard, writeRoleCard } from '../../src/core/roleCard.js';

describe('role cards and role delivery', () => {
  it('writes an immutable per-attempt card with the canonical brief digest and fixed role statement', () => {
    const project = makeProject();
    const briefPath = 'docs/briefs/RUN-4-the-way-back.md';
    project.write(briefPath, '# Run 4\n\n## Files you may edit\n- `src/run4.js`\n');
    const attempt = { attemptId: 'attempt-1', name: 'run4', lane: 'codex', at: '2026-09-16T12:00:00.000Z' };
    const card = writeRoleCard({ config: project.config, quest: quest({ id: 'RUN-4', brief: briefPath }), attempt });
    const file = path.join(project.root, card.path);
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(card.path, '.questboard-data/dispatch-briefs/RUN-4/RUN-4-attempt-1.role.md');
    assert.equal(card.digest, createHash('sha256').update(text).digest('hex'));
    assert.match(text, /canonical brief: docs\/briefs\/RUN-4-the-way-back\.md/);
    assert.match(text, /brief SHA-256: [a-f0-9]{64}/);
    assert.match(text, /你是委托包 RUN-4 的执行者。只按简报改文件，不改别的文件，不提交，不读其他 worker 的交付物；完成后把报告写到 \.work\/codex\/run4\.md。/);
    assert.throws(() => writeRoleCard({ config: project.config, quest: quest({ id: 'RUN-4', brief: briefPath }), attempt }), (error) => error.code === 'role_card_exists');
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  });

  it('fills the optional role placeholder without changing a lane that does not use it', () => {
    const project = makeProject({ lanes: {
      plain: { run: ['tools/run.sh', '{name}', '{brief}'], outputDir: '.work/plain' },
      role: { run: ['tools/run.sh', '{name}', '{role}'], outputDir: '.work/role' },
    } });
    const q = quest({ brief: 'docs/briefs/RUN-4-the-way-back.md' });
    const adventurer = { lane: 'role', model: 'model', variant: '', agent: '' };
    const rolePlan = planDispatch(project.config, q, adventurer, 'run4', q.brief, '.questboard-data/dispatch-briefs/RUN-4/a.role.md');
    assert.equal(rolePlan.at(-1).command.at(-1), '.questboard-data/dispatch-briefs/RUN-4/a.role.md');
    const plainPlan = planDispatch(project.config, q, { lane: 'plain', model: 'model', variant: '', agent: '' }, 'run4');
    assert.deepEqual(plainPlan, [{ kind: 'run', command: ['tools/run.sh', 'run4', q.brief], env: {} }]);
  });

  it('validates positive lane bounds and keeps the field name in failures', () => {
    assert.throws(() => makeProject({ lanes: {
      codex: { run: ['tools/run.sh'], outputDir: '.work/codex', limits: { maxMessages: 0 } },
    } }), /lanes\.codex\.limits\.maxMessages/);
    assert.throws(() => makeProject({ lanes: {
      codex: { run: ['tools/run.sh'], outputDir: '.work/codex', limits: { maxMinutes: 1.5 } },
    } }), /lanes\.codex\.limits\.maxMinutes/);
  });

  it('rejects unknown limit keys and role placeholders in env or session save paths', () => {
    assert.throws(() => makeProject({ lanes: {
      codex: { run: ['tools/run.sh'], outputDir: '.work/codex', limits: { maxTokens: 5 } },
    } }), /lanes\.codex\.limits.*maxTokens/);
    assert.throws(() => makeProject({ lanes: {
      envrole: { run: ['tools/run.sh'], outputDir: '.work/envrole', env: { ROLE_PATH: '{role}' } },
    } }), /lanes\.envrole\.env\.ROLE_PATH/);
    assert.throws(() => makeProject({ lanes: {
      saverole: { session: { run: ['node', 'tools/new.mjs'], saveTo: '.work/{role}.txt' }, run: ['tools/send.sh'], outputDir: '.work/saverole' },
    } }), /lanes\.saverole\.session\.saveTo/);
  });

  it('renders the session-start role prompt as card data', () => {
    const text = renderRoleCard({ packageId: 'RUN-4', kind: 'code', workerName: 'run4', attemptId: 'a', at: 't', lane: 'role', briefPath: 'docs/briefs/x.md', briefDigest: 'a'.repeat(64), reportPath: '.work/role/run4.md' });
    assert.match(text, /只按简报改文件/);
  });

  it('only adds the role card to a session prompt when roleInPrompt is enabled', () => {
    const project = makeProject({ lanes: {
      session: {
        session: { run: ['node', 'tools/new.mjs'], saveTo: '.work/session-{name}.txt' },
        run: ['tools/send.sh', '{name}', '{brief}'], outputDir: '.work/session', roleInPrompt: true,
      },
    } });
    project.write('.questboard-data/role.md', 'ROLE CARD');
    const q = quest({ brief: 'docs/briefs/RUN-4-the-way-back.md' });
    const withRole = planDispatch(project.config, q, { lane: 'session', model: 'm', variant: '' }, 'run4', q.brief, '.questboard-data/role.md');
    assert.equal(withRole[0].prompt, 'ROLE CARD');
    const withoutPrompt = makeProject({ lanes: {
      session: {
        session: { run: ['node', 'tools/new.mjs'], saveTo: '.work/session-{name}.txt' },
        run: ['tools/send.sh', '{name}', '{brief}'], outputDir: '.work/session',
      },
    } });
    const normal = planDispatch(withoutPrompt.config, q, { lane: 'session', model: 'm', variant: '' }, 'run4', q.brief, '.questboard-data/role.md');
    assert.equal(Object.hasOwn(normal[0], 'prompt'), false);
  });
});
