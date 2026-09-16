import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixture, tick } from './fixture.js';
import { appendJsonLine } from '../../src/core/jsonl.js';

const iso = '2026-09-16T12:00:00.000Z';

function addLog(fx, page, items) {
  appendJsonLine(path.join(fx.project.config.paths.data, 'annotations', `${page}.jsonl`), { page, items, savedAt: iso });
}

async function postArt(fx, id, page = 'robot8') {
  const brief = `docs/briefs/${id}-x.md`;
  fx.project.write(brief, `# ${id} original\n\nbrief body`);
  const posted = await fx.api('/api/quests', 'POST', { package: id, kind: 'art', reviewPage: page, brief });
  assert.equal(posted.status, 201, posted.text);
  return brief;
}

describe('feedback 39 annotation dispatch', () => {
  it('writes a fresh immutable snapshot, passes its path to the file lane, records provenance, and annotates the dispatched event', async () => {
    let runnerSawMetadata = false;
    let fx;
    fx = await startFixture({ runResult: () => {
      const current = fx.server.store.get('ART-39');
      runnerSawMetadata = Boolean(current?.assignee?.annotationSnapshot && fs.existsSync(path.join(fx.project.root, current.assignee.annotationSnapshot.path)));
      return { code: 0 };
    } });
    try {
      await postArt(fx, 'ART-39');
      addLog(fx, 'robot8', [{ id: 'a', verdict: 'pass', note: 'current owner note' }]);
      const assigned = await fx.api('/api/quests/ART-39/assign', 'POST', { adventurer: 'codex-astra' });
      assert.equal(assigned.status, 200, assigned.text);
      const metadata = assigned.body.quest.assignee.annotationSnapshot;
      const roleCard = assigned.body.quest.assignee.roleCard;
      assert.match(roleCard.path, /^\.questboard-data\/dispatch-briefs\/ART-39\/ART-39-[^/]+\.role\.md$/);
      assert.equal(roleCard.digest.length, 64);
      const roleText = fs.readFileSync(path.join(fx.project.root, roleCard.path), 'utf8');
      assert.match(roleText, /你是委托包 ART-39 的执行者。只按简报改文件，不改别的文件，不提交，不读其他 worker 的交付物；完成后把报告写到 \.work\/codex\/art39\.md。/);
      const detail = await fx.api('/api/quests/ART-39');
      assert.deepEqual(detail.body.quest.roleCard, roleCard);
      assert.equal(metadata.page, 'robot8');
      assert.equal(metadata.count, 1);
      assert.match(metadata.path, /^\.questboard-data\/dispatch-briefs\/ART-39\/ART-39-[^/]+\.md$/);
      assert.equal(fs.existsSync(path.join(fx.project.root, metadata.path)), true);
      const snapshotText = fs.readFileSync(path.join(fx.project.root, metadata.path), 'utf8');
      assert.ok(snapshotText.startsWith('# ART-39 original\n\nbrief body'), 'the original brief is the first content');
      assert.match(snapshotText, /current owner note/);
      await tick();
      const run = fx.calls.find((step) => step.kind === 'run');
      assert.ok(run);
      assert.equal(run.command[2], metadata.path, 'the file lane receives the generated path, not quest.brief');
      assert.equal(runnerSawMetadata, true, 'snapshot metadata and file are durable before the runner effect');
      const stored = fx.server.store.get('ART-39');
      assert.deepEqual(stored.assignee.annotationSnapshot, metadata);
      assert.deepEqual(stored.dispatches[0].annotationSnapshot, metadata);
      const dispatched = fx.events().find((event) => event.event === 'dispatched');
      assert.equal(dispatched.annotationCount, 1);
      assert.equal(dispatched.annotationPage, 'robot8');
      assert.equal(dispatched.detail.split('\n', 1)[0], '脚本已启动，worker art39');
    } finally {
      await fx.close();
    }
  });

  it('refuses a rendered snapshot over the bound before store.assign', async () => {
    const fx = await startFixture();
    try {
      await postArt(fx, 'ART-39W');
      addLog(fx, 'robot8', Array.from({ length: 500 }, (_, index) => ({
        id: `wide-${index}`, verdict: 'pass', note: '`'.repeat(4000),
      })));
      const result = await fx.api('/api/quests/ART-39W/assign', 'POST', { adventurer: 'codex-astra' });
      assert.equal(result.status, 409, result.text);
      assert.equal(result.body.reasons[0].code, 'snapshot_oversized');
      assert.deepEqual(fx.server.store.get('ART-39W').dispatches, []);
      assert.equal(fx.server.store.get('ART-39W').assignee, null);
      assert.equal(fs.existsSync(path.join(fx.project.config.paths.data, 'dispatch-briefs')), false);
      assert.equal(fx.calls.length, 0);
    } finally {
      await fx.close();
    }
  });

  it('settles a post-assign snapshot write failure as failed with an event and no runner call', async () => {
    const fx = await startFixture();
    try {
      await postArt(fx, 'ART-39F');
      const dispatchBriefs = path.join(fx.project.config.paths.data, 'dispatch-briefs');
      fs.mkdirSync(fx.project.config.paths.data, { recursive: true });
      fs.writeFileSync(dispatchBriefs, 'blocking file');
      const result = await fx.api('/api/quests/ART-39F/assign', 'POST', { adventurer: 'codex-astra' });
      assert.equal(result.status, 503, result.text);
      assert.equal(result.body.error, 'snapshot_failed_after_assign');
      assert.equal(result.body.settled, true);
      assert.match(result.body.attemptId, /^[0-9a-f-]{36}$/);
      const stored = fx.server.store.get('ART-39F');
      assert.equal(stored.status, 'failed');
      assert.equal(stored.assignee, null);
      assert.equal(stored.dispatches.length, 1);
      assert.deepEqual(fx.events().map((event) => event.event), ['posted', 'assigned', 'failed']);
      assert.match(fx.events().at(-1).detail, new RegExp(result.body.attemptId));
      assert.equal(fx.calls.length, 0);
    } finally {
      await fx.close();
    }
  });

  it('captures zero notes and gives a second attempt its own file with newer annotations', async () => {
    const fx = await startFixture();
    try {
      await postArt(fx, 'ART-39A');
      const first = await fx.api('/api/quests/ART-39A/assign', 'POST', { adventurer: 'codex-astra' });
      assert.equal(first.status, 200, first.text);
      const firstMeta = first.body.quest.assignee.annotationSnapshot;
      assert.equal(firstMeta.count, 0);
      await tick();
      const attemptId = fx.server.store.get('ART-39A').assignee.attemptId;
      fx.server.store.setStatus('ART-39A', 'failed', { detail: 'test ended', by: 'test', source: 'collector', evidence: { kind: 'collector', attemptId } });
      addLog(fx, 'robot8', [{ id: 'a', verdict: 'pass', note: 'newer note' }]);
      const second = await fx.api('/api/quests/ART-39A/assign', 'POST', { adventurer: 'codex-astra' });
      assert.equal(second.status, 200, second.text);
      const secondMeta = second.body.quest.assignee.annotationSnapshot;
      assert.notEqual(secondMeta.path, firstMeta.path);
      assert.equal(secondMeta.count, 1);
      assert.match(fs.readFileSync(path.join(fx.project.root, firstMeta.path), 'utf8'), /批注数量（引用数据）：0/);
      assert.match(fs.readFileSync(path.join(fx.project.root, secondMeta.path), 'utf8'), /newer note/);
      assert.equal(fx.server.store.get('ART-39A').dispatches[0].annotationSnapshot.path, firstMeta.path);
      assert.equal(fx.server.store.get('ART-39A').dispatches[1].annotationSnapshot.path, secondMeta.path);
    } finally {
      await fx.close();
    }
  });

  it('refuses missing, ambiguous, unconfigured, and traversal pages before assign and before snapshot creation', async () => {
    const cases = [
      { id: 'ART-39M', page: 'missing', message: '找不到编号为 missing 的评审页面' },
      { id: 'ART-39T', page: '../escape', message: '评审页面编号 ../escape 不符合页面编号格式' },
    ];
    const fx = await startFixture();
    try {
      for (const item of cases) {
        await postArt(fx, item.id, item.page);
        const result = await fx.api(`/api/quests/${item.id}/assign`, 'POST', { adventurer: 'codex-astra' });
        assert.equal(result.status, 409, result.text);
        assert.equal(result.body.reasons[0].message, item.message);
        assert.deepEqual(fx.server.store.get(item.id).dispatches, []);
        assert.equal(fx.server.store.get(item.id).assignee, null);
        assert.equal(fs.existsSync(path.join(fx.project.config.paths.data, 'dispatch-briefs', item.id)), false);
      }
    } finally {
      await fx.close();
    }

    const ambiguous = await startFixture();
    try {
      ambiguous.project.write('docs/art/review_duplicate.html', '<script type="application/json" id="review-data">{"page":"robot8","title":"Duplicate"}</script>');
      await postArt(ambiguous, 'ART-39D');
      const result = await ambiguous.api('/api/quests/ART-39D/assign', 'POST', { adventurer: 'codex-astra' });
      assert.equal(result.status, 409, result.text);
      assert.equal(result.body.reasons[0].message, '评审页面编号 robot8 对应多个文件');
      assert.deepEqual(ambiguous.server.store.get('ART-39D').dispatches, []);
      assert.equal(fs.existsSync(path.join(ambiguous.project.config.paths.data, 'dispatch-briefs', 'ART-39D')), false);
    } finally {
      await ambiguous.close();
    }

    const unconfigured = await startFixture({ projectOverrides: { reviewPages: null } });
    try {
      await postArt(unconfigured, 'ART-39U');
      const result = await unconfigured.api('/api/quests/ART-39U/assign', 'POST', { adventurer: 'codex-astra' });
      assert.equal(result.status, 409, result.text);
      assert.equal(result.body.reasons[0].message, '项目没有配置评审目录');
      assert.deepEqual(unconfigured.server.store.get('ART-39U').dispatches, []);
      assert.equal(fs.existsSync(path.join(unconfigured.project.config.paths.data, 'dispatch-briefs', 'ART-39U')), false);
    } finally {
      await unconfigured.close();
    }
  });
});
