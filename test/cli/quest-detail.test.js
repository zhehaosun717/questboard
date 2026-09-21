// QB-FB-F: questboard get / show / release and the board author default, run as real CLI
// subprocesses against a temporary server (not-found, refused and dead-server cases included).
// The calls are async on purpose: spawnSync would freeze this process's event loop and the
// in-process fixture server could never answer the child.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixture, tick } from '../server/fixture.js';
import { REPORT_READ_CAP, captureAttemptReport } from '../../src/core/reportEvidence.js';
import { appendJsonLine } from '../../src/core/jsonl.js';

const run = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'questboard.js');
let fx;
async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { timeout: 20000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, QUESTBOARD_PROJECT: '', QUESTBOARD_URL: '' } });
    return { status: 0, stdout, stderr };
  } catch (error) {
    return { status: error.code === undefined ? 1 : error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}
const atBoard = (args) => cli([...args, '--project', fx.project.root, '--url', fx.base]);

before(async () => {
  fx = await startFixture();
  fx.project.write('docs/briefs/QD-1-read-me-once.md', '# QD-1\n\n## Files you may edit\n\n- `src/qd/a.js`\n');
  const posted = await fx.api('/api/quests', 'POST', { package: 'QD-1', brief: 'docs/briefs/QD-1-read-me-once.md' });
  assert.equal(posted.status, 201);
});
after(() => fx.close());

describe('questboard get', () => {
  it('reads one quest in concise readable lines', async () => {
    const got = await atBoard(['get', 'QD-1']);
    assert.equal(got.status, 0, got.stderr);
    assert.match(got.stdout, /^QD-1\s+posted\s+code\s/m);
    assert.match(got.stdout, /第 1 版/);
    assert.match(got.stdout, /可改文件: src\/qd\/a\.js/);
    assert.match(got.stdout, /可接手: .*codex-luna/);
  });

  it('--json prints the enriched quest for agents, and show is the same read', async () => {
    const got = await atBoard(['get', 'QD-1', '--json']);
    assert.equal(got.status, 0, got.stderr);
    const quest = JSON.parse(got.stdout);
    const direct = (await fx.api('/api/quests/QD-1')).body.quest;
    assert.deepEqual(quest, direct, 'the CLI shows the canonical enriched contract, nothing invented');
    assert.equal(quest.assignee, null);
    assert.deepEqual(quest.dispatches, []);
    assert.deepEqual(quest.threads, []);
    assert.ok(Array.isArray(quest.eligibility.canTake));
    assert.equal((await atBoard(['show', 'QD-1'])).status, 0);
  });

  it('prints the annotation summary (count + first notes) for a quest with a review page (FB2-02 item 6)', async () => {
    fx.project.write('docs/briefs/ART-70-x.md', '# ART-70');
    const posted = await fx.api('/api/quests', 'POST', { package: 'ART-70', kind: 'art', reviewPage: 'robot8', brief: 'docs/briefs/ART-70-x.md' });
    assert.equal(posted.status, 201, posted.text);
    appendJsonLine(path.join(fx.project.config.paths.data, 'annotations', 'robot8.jsonl'), {
      page: 'robot8',
      items: [
        { id: 'a', verdict: 'pass', note: '构图可以', updatedAt: '2026-09-20T00:00:00.000Z' },
        { id: 'b', verdict: 'fail', note: '颜色不对', updatedAt: '2026-09-20T00:00:00.000Z' },
        { id: 'c', verdict: 'needs-fix', note: '手再修一下', updatedAt: '2026-09-20T00:00:00.000Z' },
      ],
      savedAt: '2026-09-20T00:00:00.000Z',
    });
    const result = await atBoard(['get', 'ART-70']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /批注 3 条/);
    assert.match(result.stdout, /通过 1/);
    assert.match(result.stdout, /不行 1/);
    assert.match(result.stdout, /需要修改 1/);
    assert.match(result.stdout, /构图可以/);
    assert.match(result.stdout, /颜色不对/);
    const json = await atBoard(['get', 'ART-70', '--json']);
    const detail = JSON.parse(json.stdout);
    assert.equal(detail.annotationSummary.total, 3);
    assert.equal(detail.annotationSummary.page, 'robot8');
  });
  it('flags never become the id, and a missing id shows usage', async () => {
    const late = await atBoard(['get', 'QD-1']);
    assert.equal(late.status, 0, late.stderr);
    const first = await cli(['get', '--project', fx.project.root, '--url', fx.base, 'QD-1']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /QD-1\s+posted/);
    const noId = await cli(['get', '--project', fx.project.root, '--url', fx.base]);
    assert.equal(noId.status, 1);
    assert.match(noId.stderr, /usage: questboard get/);
  });

  it('a missing quest and a dead server both fail loudly with clear words', async () => {
    const missing = await atBoard(['get', 'NOPE-1']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /quest not found/);
    const dead = await cli(['get', 'QD-1', '--project', fx.project.root, '--url', 'http://127.0.0.1:1']);
    assert.equal(dead.status, 1);
    assert.match(dead.stderr, /看板服务没在 http:\/\/127\.0\.0\.1:1 运行/);
  });
});

describe('questboard release', () => {
  before(async () => {
    fx.project.write('docs/briefs/REL-1-silent-worker.md', 'x');
    await fx.api('/api/quests', 'POST', { package: 'REL-1', brief: 'docs/briefs/REL-1-silent-worker.md' });
    assert.equal((await fx.api('/api/quests/REL-1/assign', 'POST', { adventurer: 'codex-luna' })).status, 200);
    await tick();
  });

  it('demands --detail evidence before asking the server for anything', async () => {
    const noFlag = await atBoard(['release', 'REL-1']);
    assert.equal(noFlag.status, 1);
    assert.match(noFlag.stderr, /--detail/);
    const blank = await atBoard(['release', 'REL-1', '--detail', '   ']);
    assert.equal(blank.status, 1);
    assert.match(blank.stderr, /沉默不等于离开/);
    const noId = await cli(['release', '--detail', 'checked ps', '--project', fx.project.root, '--url', fx.base]);
    assert.equal(noId.status, 1);
    assert.match(noId.stderr, /usage: questboard release/);
    assert.notEqual(fx.events().at(-1).event, 'released', 'the CLI asked the server for no release at all');
  });

  it('refuses a flag token as the --detail evidence before touching the network', async () => {
    const before = fx.events().length;
    const flagAsDetail = await atBoard(['release', 'REL-1', '--detail', '--by', 'x']);
    assert.equal(flagAsDetail.status, 1);
    assert.match(flagAsDetail.stderr, /--detail/);
    // REL-1 is running here, so a request that reached the server would answer with its own refusal.
    assert.doesNotMatch(flagAsDetail.stderr, /running; cancel/, 'the server was never asked');
    const dead = await cli(['release', 'REL-1', '--detail', '--by', 'x', '--project', fx.project.root, '--url', 'http://127.0.0.1:1']);
    assert.equal(dead.status, 1);
    assert.match(dead.stderr, /--detail/);
    assert.doesNotMatch(dead.stderr, /看板服务没在/, 'the rejection happened before opening a socket');
    assert.equal(fx.events().length, before, 'a rejected release emits no event');
  });

  it('refuses a running quest whose process tree is not verified empty, and frees it only after a confirmed stall', async () => {
    const tooEarly = await atBoard(['release', 'REL-1', '--detail', 'ps shows nothing']);
    assert.equal(tooEarly.status, 1);
    assert.match(tooEarly.stderr, /先 cancel 再 release/, 'FB2-06: an unverified tree still refuses, naming the cancel-first path');
    await fx.api('/api/quests/REL-1/status', 'POST', { status: 'stalled', detail: 'no output' });
    const done = await cli(['release', '--project', fx.project.root, '--url', fx.base, '--detail', '进程已确认退出', 'REL-1']);
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /REL-1\s+stalled/);
    const quest = (await fx.api('/api/quests/REL-1')).body.quest;
    assert.equal(quest.assignee, null, 'the freed quest keeps no worker');
    assert.equal(quest.lastDetail, '进程已确认退出');
    const last = fx.events().at(-1);
    assert.deepEqual([last.event, last.detail], ['released', '进程已确认退出']);
  });
});

describe('questboard cancel and resolve', () => {
  before(async () => {
    fx.project.write('docs/briefs/CLI-CANCEL-1.md', 'CLI-CANCEL-1');
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'CLI-CANCEL-1', brief: 'docs/briefs/CLI-CANCEL-1.md' })).status, 201);
    assert.equal((await fx.api('/api/quests/CLI-CANCEL-1/assign', 'POST', { adventurer: 'codex-luna' })).status, 200);
  });

  it('uses the CLI source and keeps the slot until explicit resolve acknowledgement', async () => {
    const requested = await atBoard(['cancel', 'CLI-CANCEL-1', '--reason', 'owner stopped this attempt']);
    assert.equal(requested.status, 0, requested.stderr);
    assert.match(requested.stdout, /取消结果：无法自动停止，需要手动处理/);
    const resolved = await atBoard(['resolve', 'CLI-CANCEL-1', '--reason', 'CLI confirmed the worker is gone', '--ack']);
    assert.equal(resolved.status, 0, resolved.stderr);
    const quest = (await fx.api('/api/quests/CLI-CANCEL-1')).body.quest;
    assert.equal(quest.assignee, null);
    assert.equal(quest.manualResolution.actorSource, 'cli');
  });
});

describe('board author default', () => {
  it('fills a missing author with coordinator at the CLI boundary only', async () => {
    assert.equal((await atBoard(['board', 'post', '--title', 'QD-1 which lane', '--body', '该用哪张卡'])).status, 0);
    const thread = fx.server.boardStore.listThreads({}).find((t) => t.title === 'QD-1 which lane');
    assert.equal(thread.author, 'coordinator');
    assert.equal((await atBoard(['board', 'reply', '--thread', thread.id, '--body', '补充一句'])).status, 0);
    const read = await fx.api(`/api/threads/${thread.id}`);
    assert.equal(read.body.messages.at(-1).author, 'coordinator');
    assert.equal((await atBoard(['board', 'post', '--title', 'QD-1 noted', '--body', 'b', '--author', 'worker-1'])).status, 0);
    assert.equal(fx.server.boardStore.listThreads({}).find((t) => t.title === 'QD-1 noted').author, 'worker-1');
    const refused = await fx.api('/api/threads', 'POST', { title: 'no-author', body: 'b' });
    assert.equal(refused.status, 400, 'the HTTP API still requires an author; the default lives in the CLI');
  });
});

// Feedback 7: `get` prints the attempt's own report reference/verdict/first paragraph; `--report` asks the
// board for the bounded plain text itself. A quest with no stored reference says 报告不可用 instead of
// silently printing nothing that could be mistaken for "the report is fine".
describe('questboard get — report evidence', () => {
  before(async () => {
    fx.project.write('docs/briefs/RPT-1-answer.md', 'brief');
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'RPT-1', brief: 'docs/briefs/RPT-1-answer.md' })).status, 201);
    assert.equal((await fx.api('/api/quests/RPT-1/assign', 'POST', { adventurer: 'oc-mimo' })).status, 200);
    await tick();
    const store = fx.server.store;
    const name = store.get('RPT-1').assignee.name;
    const text = '# 报告\n\n第一段。\n\nVERDICT: PASS\n';
    fs.mkdirSync(path.join(fx.project.root, '.work', 'oc'), { recursive: true });
    fx.project.write(`.work/oc/${name}.md`, text);
    const report = captureAttemptReport({ config: fx.project.config, quest: store.get('RPT-1') });
    store.setStatus('RPT-1', 'delivered', { detail: `交付已写入 .work/oc/${name}.md`, by: 'lanes', source: 'collector', evidence: { kind: 'collector', attemptId: store.get('RPT-1').assignee.attemptId }, report });
  });

  it('prints the report reference, verdict and first paragraph', async () => {
    const got = await atBoard(['get', 'RPT-1']);
    assert.equal(got.status, 0, got.stderr);
    assert.match(got.stdout, /报告: \.work\/oc\/rpt1\.md/);
    assert.match(got.stdout, /结论: 通过（原文：VERDICT: PASS）/);
    assert.match(got.stdout, /摘要: .*第一段/);
  });

  it('--report prints the bounded plain text itself', async () => {
    const got = await atBoard(['get', 'RPT-1', '--report']);
    assert.equal(got.status, 0, got.stderr);
    assert.match(got.stdout, /VERDICT: PASS/);
    assert.match(got.stdout, /第一段。/);
  });

  // S2: --evidence prints the structured, attempt-bound evidence object (src/core/evidence.js) as JSON.
  it('--evidence prints the structured evidence object, with the report item bound to this attempt', async () => {
    const got = await atBoard(['get', 'RPT-1', '--evidence']);
    assert.equal(got.status, 0, got.stderr);
    const evidence = JSON.parse(got.stdout);
    assert.equal(evidence.version, 1);
    const report = evidence.items.find((item) => item.kind === 'report');
    assert.deepEqual([report.state, report.bound, report.ref], ['passed', true, '.work/oc/rpt1.md']);
  });

  it('a quest with nothing stored says so in Chinese', async () => {
    fx.project.write('docs/briefs/RPT-2-answer.md', 'brief');
    await fx.api('/api/quests', 'POST', { package: 'RPT-2', brief: 'docs/briefs/RPT-2-answer.md' });
    const none = await atBoard(['get', 'RPT-2', '--report']);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /报告不可用/);
    const detail = await atBoard(['get', 'RPT-2']);
    assert.equal(detail.status, 0, detail.stderr);
    assert.doesNotMatch(detail.stdout, /报告: /, 'no reference line when nothing was ever captured');
  });

  it('warns on stderr when --report got a truncated read instead of the whole report', async () => {
    fx.project.write('docs/briefs/RPT-3-big.md', 'brief');
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'RPT-3', brief: 'docs/briefs/RPT-3-big.md' })).status, 201);
    assert.equal((await fx.api('/api/quests/RPT-3/assign', 'POST', { adventurer: 'oc-mimo' })).status, 200);
    await tick();
    const store = fx.server.store;
    const name = store.get('RPT-3').assignee.name;
    fs.mkdirSync(path.join(fx.project.root, '.work', 'oc'), { recursive: true });
    fx.project.write(`.work/oc/${name}.md`, `VERDICT: PASS\n${'y'.repeat(REPORT_READ_CAP)}\nVERDICT: FAIL\n`);
    const report = captureAttemptReport({ config: fx.project.config, quest: store.get('RPT-3') });
    assert.equal(report.truncated, true, 'the fixture file must sit over the read cap');
    store.setStatus('RPT-3', 'delivered', { detail: `交付已写入 .work/oc/${name}.md`, by: 'lanes', source: 'collector', evidence: { kind: 'collector', attemptId: store.get('RPT-3').assignee.attemptId }, report });

    const got = await atBoard(['get', 'RPT-3', '--report']);
    assert.equal(got.status, 0, got.stderr);
    assert.match(got.stderr, /报告没有读完整，只显示了前 \d+ 字节，不是完整报告/);
    assert.equal(got.stdout.length, REPORT_READ_CAP + 1, 'the printed body stays bounded even when the file does not');

    const detail = await atBoard(['get', 'RPT-3']);
    assert.equal(detail.status, 0, detail.stderr);
    assert.match(detail.stdout, /结论: 不确定（报告超过 2 MB/);
  });

  it('prints 结论: 通过但有问题 for PASS WITH FINDINGS', async () => {
    fx.project.write('docs/briefs/RPT-4-findings.md', 'brief');
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'RPT-4', brief: 'docs/briefs/RPT-4-findings.md' })).status, 201);
    assert.equal((await fx.api('/api/quests/RPT-4/assign', 'POST', { adventurer: 'oc-mimo' })).status, 200);
    await tick();
    const store = fx.server.store;
    const name = store.get('RPT-4').assignee.name;
    const text = '# 报告\n\n小问题。\n\nVERDICT: PASS WITH FINDINGS\n';
    fs.mkdirSync(path.join(fx.project.root, '.work', 'oc'), { recursive: true });
    fx.project.write(`.work/oc/${name}.md`, text);
    const report = captureAttemptReport({ config: fx.project.config, quest: store.get('RPT-4') });
    store.setStatus('RPT-4', 'delivered', { detail: `交付已写入 .work/oc/${name}.md`, by: 'lanes', source: 'collector', evidence: { kind: 'collector', attemptId: store.get('RPT-4').assignee.attemptId }, report });

    const got = await atBoard(['get', 'RPT-4']);
    assert.equal(got.status, 0, got.stderr);
    assert.match(got.stdout, /结论: 通过但有问题/);
  });

  it('prints 结论: 不通过 for a FAIL report', async () => {
    fx.project.write('docs/briefs/RPT-5-fail.md', 'brief');
    assert.equal((await fx.api('/api/quests', 'POST', { package: 'RPT-5', brief: 'docs/briefs/RPT-5-fail.md' })).status, 201);
    assert.equal((await fx.api('/api/quests/RPT-5/assign', 'POST', { adventurer: 'oc-mimo' })).status, 200);
    await tick();
    const store = fx.server.store;
    const name = store.get('RPT-5').assignee.name;
    const text = '# 报告\n\n未完成。\n\nVERDICT: FAIL\n';
    fs.mkdirSync(path.join(fx.project.root, '.work', 'oc'), { recursive: true });
    fx.project.write(`.work/oc/${name}.md`, text);
    const report = captureAttemptReport({ config: fx.project.config, quest: store.get('RPT-5') });
    store.setStatus('RPT-5', 'delivered', { detail: `交付已写入 .work/oc/${name}.md`, by: 'lanes', source: 'collector', evidence: { kind: 'collector', attemptId: store.get('RPT-5').assignee.attemptId }, report });

    const got = await atBoard(['get', 'RPT-5']);
    assert.equal(got.status, 0, got.stderr);
    assert.match(got.stdout, /结论: 不通过/);
  });
});


describe('FB2-03 post/update flags and get output', () => {
  it('post echoes the file set; supersedes shows on get in both directions', async () => {
    fx.project.write('docs/briefs/QD-30-old.md', '# QD-30\n\n## Files you may edit\n\n- `src/qd30/a.js`\n');
    fx.project.write('docs/briefs/QD-31-new.md', '# QD-31');
    const posted = await atBoard(['post', '--package', 'QD-30', '--brief', 'docs/briefs/QD-30-old.md']);
    assert.equal(posted.status, 0, posted.stderr);
    assert.match(posted.stdout, /可改文件（brief 抽取）: src\/qd30\/a\.js/);
    const overridden = await atBoard(['post', '--package', 'QD-31', '--brief', 'docs/briefs/QD-31-new.md', '--files', 'src/qd31/only.js', '--supersedes', 'QD-30']);
    assert.equal(overridden.status, 0, overridden.stderr);
    assert.match(overridden.stdout, /可改文件（显式指定）: src\/qd31\/only\.js/);
    const oldGet = await atBoard(['get', 'QD-30']);
    assert.match(oldGet.stdout, /取代: 被 QD-31 取代/);
    const newGet = await atBoard(['get', 'QD-31']);
    assert.match(newGet.stdout, /取代: 取代了 QD-30/);
  });

  it('update sets and clears a hold; get shows it while it is on', async () => {
    fx.project.write('docs/briefs/QD-32-hold.md', '# QD-32');
    await atBoard(['post', '--package', 'QD-32', '--brief', 'docs/briefs/QD-32-hold.md']);
    const held = await atBoard(['update', 'QD-32', '--hold', '等设计稿']);
    assert.equal(held.status, 0, held.stderr);
    const during = await atBoard(['get', 'QD-32']);
    assert.match(during.stdout, /挂起: 等设计稿/);
    const cleared = await atBoard(['update', 'QD-32', '--hold', '']);
    assert.equal(cleared.status, 0, cleared.stderr);
    const after = await atBoard(['get', 'QD-32']);
    assert.ok(!/挂起:/.test(after.stdout));
  });

  it('post --needs lands on the quest and get shows it', async () => {
    fx.project.write('docs/briefs/QD-33-needs.md', '# QD-33');
    const posted = await atBoard(['post', '--package', 'QD-33', '--brief', 'docs/briefs/QD-33-needs.md', '--needs', 'runs-node,web']);
    assert.equal(posted.status, 0, posted.stderr);
    const got = await atBoard(['get', 'QD-33']);
    assert.match(got.stdout, /需要能力: runs-node, web/);
    assert.match(got.stdout, /能力不够/);
  });
});

