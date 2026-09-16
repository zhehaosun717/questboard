// Pins the report-evidence contract: one dispatch attempt resolves only through its own lane directories,
// the verdict is parsed from the full text (never a 300-char tail), and a summary cuts on line boundaries.
// It also proves the anti-inheritance rules: a stale attempt and a legacy row never show a report.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { makeProject } from '../helpers.js';
import {
  REPORT_READ_CAP, SUMMARY_VERDICT_REASON, resolveAttemptReport, extractVerdict, summarizeReport,
  captureAttemptReport, readCapturedReport, questReportView, reportSnapshot,
} from '../../src/core/reportEvidence.js';

const sha = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const attempt = (overrides = {}) => ({ name: 'mod1', lane: 'opencode', at: '2026-09-14T00:00:00.000Z', attemptId: 'a1', ...overrides });

// Writes a file under the project root, creating parents first (the helpers' own writer stays untouched).
function put(root, relative, text) {
  const abs = path.join(root, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}

describe('extractVerdict', () => {
  it('finds a verdict that sits far above the tail of a long report', () => {
    const text = ['VERDICT: PASS', ...Array(500).fill('长报告的一行正文'), ''].join('\n');
    const found = extractVerdict(text);
    assert.equal(found.verdict, 'PASS');
    assert.equal(found.line, 'VERDICT: PASS');
    assert.ok(found.position < 50, '结论在第一行，不在结尾');
    assert.ok(text.length - found.position > 3000, '300 字的 lastDetail 尾段不可能包含这一行');
  });

  it('ignores a fenced sample and takes the genuine line outside it', () => {
    const text = ['# 战报', '```', 'VERDICT: FAIL', '```', '', 'VERDICT: PASS', ''].join('\n');
    assert.equal(extractVerdict(text).verdict, 'PASS');
  });

  it('ignores an echoed template line', () => {
    const text = ['任务模板要求最后写一行：', 'VERDICT: PASS|FAIL', ''].join('\n');
    assert.equal(extractVerdict(text).verdict, 'unknown');
  });

  it('ignores quoted and indented transcript lines', () => {
    const text = ['> VERDICT: FAIL', '    VERDICT: FAIL', '报告正文在这里'].join('\n');
    assert.equal(extractVerdict(text).verdict, 'unknown');
  });

  it('takes the last genuine line when the report repeats the verdict', () => {
    const text = ['VERDICT: FAIL', '中间还有很多行', 'VERDICT: PASS', ''].join('\n');
    const found = extractVerdict(text);
    assert.equal(found.verdict, 'PASS');
    assert.ok(found.position > text.indexOf('中间'), '取的是最后一行真结论');
  });

  it('stays unknown on ambiguous tokens and mid-sentence mentions', () => {
    assert.equal(extractVerdict('VERDICT: MAYBE\n').verdict, 'unknown');
    assert.equal(extractVerdict('The verdict: PASS (from the template)\n').verdict, 'unknown');
    assert.equal(extractVerdict('VERDICT:\n').verdict, 'unknown');
  });

  it('says unknown with no line at all', () => {
    assert.deepEqual(extractVerdict('只有一段正文，没有结论行'), { verdict: 'unknown', line: null, position: null });
  });

  it('keeps a backtick fence open across a tilde line (CommonMark)', () => {
    const text = ['```', '~~~', 'VERDICT: PASS', '```', '', 'VERDICT: FAIL', ''].join('\n');
    const found = extractVerdict(text);
    assert.equal(found.verdict, 'FAIL', '栅栏里的 PASS 不算数');
    assert.ok(found.position > text.indexOf('~~~'), '取的是栅栏关闭之后的真结论');
  });

  it('keeps a fence open across a shorter fence of the same character', () => {
    const text = ['````', '```', 'VERDICT: PASS', '````', '', 'VERDICT: FAIL', ''].join('\n');
    assert.equal(extractVerdict(text).verdict, 'FAIL');
  });

  it('refuses values that offer a choice instead of one verdict', () => {
    for (const value of ['PASS or FAIL', 'PASS / FAIL', '<PASS|FAIL>', '[PASS]']) {
      assert.equal(extractVerdict(`VERDICT: ${value}\n`).verdict, 'unknown', value);
    }
  });

  it('matches VERDICT case-sensitively: lowercase prose is not a verdict', () => {
    for (const line of ['verdict: pass', 'Verdict: Pass', 'VERDICT: pass']) {
      assert.equal(extractVerdict(`${line}\n`).verdict, 'unknown', line);
    }
  });
});

describe('summarizeReport', () => {
  it('keeps the first heading and the first complete paragraph on line boundaries', () => {
    const summary = summarizeReport('# 战报\n\n第一段第一行\n第一段第二行\n\n第二段\n');
    assert.equal(summary.heading, '战报');
    assert.equal(summary.paragraph, '第一段第一行\n第一段第二行');
    assert.equal(summary.hasMore, true);
  });

  it('treats the first findings item as the paragraph', () => {
    const summary = summarizeReport('## 发现\n\n- 第一条发现\n- 第二条发现\n');
    assert.equal(summary.heading, '发现');
    assert.equal(summary.paragraph, '- 第一条发现');
    assert.equal(summary.hasMore, true);
  });

  it('is CRLF safe', () => {
    const summary = summarizeReport('# 战报\r\n\r\n第一段。\r\n\r\nVERDICT: PASS\r\n');
    assert.equal(summary.heading, '战报');
    assert.equal(summary.paragraph, '第一段。');
  });

  it('cuts a long CJK paragraph at the cap without breaking characters', () => {
    const summary = summarizeReport(`# t\n\n${'汉'.repeat(500)}\n`);
    assert.ok([...summary.paragraph].length <= 401, '一次最多 400 字加一个省略号');
    assert.ok(summary.paragraph.endsWith('…'));
    assert.equal(summary.hasMore, true);
  });

  it('returns nulls for an empty report', () => {
    assert.deepEqual(summarizeReport(''), { heading: null, paragraph: null, hasMore: false });
  });
});

describe('resolveAttemptReport', () => {
  it('binds a delivery file through the lane delivery directory', () => {
    const project = makeProject();
    const text = '# 战报\n\n交付内容。\n\nVERDICT: PASS\n';
    const abs = put(project.root, '.work/oc/mod1.md', text);
    const found = resolveAttemptReport({ config: project.config, quest: { id: 'RPT-1', assignee: attempt() } });
    assert.equal(found.source, 'delivery');
    assert.equal(found.ref, '.work/oc/mod1.md');
    assert.equal(found.digest, sha(text));
    assert.equal(found.bytes, Buffer.byteLength(text));
    assert.equal(found.truncated, false);
    assert.equal(found.text, text);
    assert.equal(found.attemptId, 'a1');
    assert.ok(fs.existsSync(abs));
  });

  it('falls back to the exit-file summary when no delivery file exists', () => {
    const project = makeProject();
    const text = 'exit 0\n部分结论\n';
    put(project.root, '.work/codex/luna.out', text);
    const found = resolveAttemptReport({ config: project.config, quest: { id: 'RPT-2', assignee: attempt({ name: 'luna', lane: 'codex', attemptId: 'a2' }) } });
    assert.equal(found.source, 'summary');
    assert.equal(found.ref, '.work/codex/luna.out');
    assert.equal(found.text, text);
  });

  it('reports none with a reason when nothing was left behind', () => {
    const project = makeProject();
    const found = resolveAttemptReport({ config: project.config, quest: { id: 'RPT-3', assignee: attempt() } });
    assert.equal(found.source, 'none');
    assert.equal(found.ref, null);
    assert.match(found.reason, /没有留下可读的报告/);
  });

  it('refuses an unsafe worker name instead of pasting it into a path', () => {
    const project = makeProject();
    const found = resolveAttemptReport({ config: project.config, quest: { id: 'RPT-4', assignee: attempt({ name: '../evil' }) } });
    assert.equal(found.source, 'none');
    assert.match(found.reason, /不是一个安全的文件名/);
  });

  it('reports none before any dispatch', () => {
    const project = makeProject();
    const found = resolveAttemptReport({ config: project.config, quest: { id: 'RPT-5' } });
    assert.equal(found.source, 'none');
    assert.match(found.reason, /还没有派过单/);
  });

  it('refuses a symlinked report directory that points outside the project', () => {
    const project = makeProject();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-outside-'));
    fs.mkdirSync(path.join(project.root, '.work'), { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(project.root, '.work', 'oc'), 'dir');
    } catch {
      return; // Windows without developer mode refuses symlinks; the containment guard is still covered above
    }
    fs.writeFileSync(path.join(outside, 'mod1.md'), '# 战报\nVERDICT: PASS\n');
    const found = resolveAttemptReport({ config: project.config, quest: { id: 'RPT-6', assignee: attempt() } });
    assert.equal(found.source, 'none');
    assert.match(found.reason, /没有留下可读的报告/);
  });

  it('truncates an oversized report instead of pretending it read it all', () => {
    const project = makeProject();
    const text = 'x'.repeat(REPORT_READ_CAP + 64);
    put(project.root, '.work/oc/big.md', text);
    const found = resolveAttemptReport({ config: project.config, quest: { id: 'RPT-7', assignee: attempt({ name: 'big' }) } });
    assert.equal(found.truncated, true);
    assert.equal(found.bytes, REPORT_READ_CAP);
    assert.equal(found.sizeBytes, text.length);
    assert.equal(found.text.length, REPORT_READ_CAP);
  });
});

describe('captureAttemptReport', () => {
  it('records the verdict and the first paragraph alongside the reference', () => {
    const project = makeProject();
    const text = '# 战报\n\n交付内容。\n\nVERDICT: PASS\n';
    put(project.root, '.work/oc/mod1.md', text);
    const capture = captureAttemptReport({ config: project.config, quest: { id: 'RPT-8', assignee: attempt() } });
    assert.equal(capture.source, 'delivery');
    assert.equal(capture.verdict.verdict, 'PASS');
    assert.equal(capture.verdict.line, 'VERDICT: PASS');
    assert.equal(capture.summary.heading, '战报');
    assert.equal(capture.summary.paragraph, '交付内容。');
  });

  it('keeps only the reason when nothing was found', () => {
    const project = makeProject();
    const capture = captureAttemptReport({ config: project.config, quest: { id: 'RPT-9', assignee: attempt() } });
    assert.equal(capture.source, 'none');
    assert.equal(capture.verdict, undefined);
    assert.equal(capture.summary, undefined);
    assert.match(capture.reason, /没有留下可读的报告/);
  });

  it('records truncated: true and an unknown verdict when the report is larger than the read cap', () => {
    const project = makeProject();
    const text = `VERDICT: PASS\n${'y'.repeat(REPORT_READ_CAP)}\nVERDICT: FAIL\n`;
    put(project.root, '.work/oc/big.md', text);
    const quest = { id: 'RPT-17', assignee: { ...attempt(), name: 'big' } };
    const capture = captureAttemptReport({ config: project.config, quest });
    assert.equal(capture.truncated, true);
    assert.equal(capture.bytes, REPORT_READ_CAP);
    assert.equal(capture.verdict.verdict, 'unknown', '读到一半的 PASS 不是最终结论');
    assert.match(capture.verdict.reason, /超过 2 MB/);
    assert.match(capture.verdict.reason, /没有读到结尾/);
    const snapshot = reportSnapshot({ ...quest, attemptReport: capture });
    assert.equal(snapshot.verdict, 'unknown');
    assert.equal(snapshot.verdictReason, capture.verdict.reason, '快照也必须说明截断导致结论不可用');
  });

  it('keeps both kinds of .out transcript unknown with a Chinese reason', () => {
    const project = makeProject();
    const transcripts = [
      ['brief echoed VERDICT: PASS', 'brief echoed VERDICT: FAIL', 'exec failed'].join('\n'),
      '{"type":"text","text":"VERDICT: PASS"}\n',
    ];
    for (const [index, text] of transcripts.entries()) {
      const quest = { id: `RPT-${19 + index}`, assignee: attempt({ name: `luna${index}`, lane: 'codex', attemptId: `a${19 + index}` }) };
      put(project.root, `.work/codex/luna${index}.out`, text);
      const capture = captureAttemptReport({ config: project.config, quest });
      assert.equal(capture.source, 'summary');
      assert.equal(capture.verdict.verdict, 'unknown');
      assert.equal(capture.verdict.reason, SUMMARY_VERDICT_REASON);
      const snapshot = reportSnapshot({ ...quest, attemptReport: capture });
      assert.equal(snapshot.verdict, 'unknown');
      assert.equal(snapshot.verdictReason, SUMMARY_VERDICT_REASON);
    }
  });

  it('still reads the verdict when the report ends exactly at the cap', () => {
    const project = makeProject();
    const prefix = 'VERDICT: PASS\n';
    put(project.root, '.work/oc/exact.md', prefix + 'y'.repeat(REPORT_READ_CAP - prefix.length));
    const capture = captureAttemptReport({ config: project.config, quest: { id: 'RPT-18', assignee: { ...attempt(), name: 'exact' } } });
    assert.equal(capture.truncated, false);
    assert.equal(capture.bytes, REPORT_READ_CAP);
    assert.equal(capture.verdict.verdict, 'PASS');
  });

  it('never reads a verdict out of a .out transcript', () => {
    const project = makeProject();
    put(project.root, '.work/codex/luna.out', ['codex 运行记录：', 'VERDICT: PASS', 'exec failed', ''].join('\n'));
    const capture = captureAttemptReport({ config: project.config, quest: { id: 'RPT-19', assignee: { ...attempt(), lane: 'codex', name: 'luna' } } });
    assert.equal(capture.source, 'summary');
    assert.equal(capture.verdict.verdict, 'unknown');
    assert.match(capture.verdict.reason, /运行记录/);
  });

  it('never takes an echoed brief line of a transcript as the verdict', () => {
    const project = makeProject();
    put(project.root, '.work/codex/echo.out', ['要求最后写一行：', 'VERDICT: FAIL', '……', '其它输出', ''].join('\n'));
    const capture = captureAttemptReport({ config: project.config, quest: { id: 'RPT-20', assignee: { ...attempt(), lane: 'codex', name: 'echo' } } });
    assert.equal(capture.source, 'summary');
    assert.equal(capture.verdict.verdict, 'unknown');
    assert.match(capture.verdict.reason, /运行记录/);
  });
});

describe('readCapturedReport', () => {
  it('re-reads the same bytes the digest was taken from', () => {
    const project = makeProject();
    const text = '正文\nVERDICT: FAIL\n';
    put(project.root, '.work/oc/mod1.md', text);
    const capture = captureAttemptReport({ config: project.config, quest: { id: 'RPT-10', assignee: attempt() } });
    const read = readCapturedReport(project.config, capture);
    assert.equal(read.ok, true);
    assert.equal(read.text, text);
    assert.equal(read.digest, capture.digest);
    assert.equal(read.ref, '.work/oc/mod1.md');
  });

  it('refuses a report that changed after it was recorded', () => {
    const project = makeProject();
    put(project.root, '.work/oc/mod1.md', 'VERDICT: PASS\n');
    const capture = captureAttemptReport({ config: project.config, quest: { id: 'RPT-11', assignee: attempt() } });
    put(project.root, '.work/oc/mod1.md', 'VERDICT: FAIL\n');
    const read = readCapturedReport(project.config, capture);
    assert.equal(read.ok, false);
    assert.equal(read.code, 'changed');
    assert.match(read.reason, /改过/);
  });

  it('says gone when the file behind the reference is missing', () => {
    const project = makeProject();
    put(project.root, '.work/oc/mod1.md', 'VERDICT: PASS\n');
    const capture = captureAttemptReport({ config: project.config, quest: { id: 'RPT-12', assignee: attempt() } });
    fs.rmSync(path.join(project.root, '.work/oc/mod1.md'));
    const read = readCapturedReport(project.config, capture);
    assert.equal(read.ok, false);
    assert.equal(read.code, 'gone');
  });

  it('says none when there never was a reference', () => {
    const read = readCapturedReport(makeProject().config, { source: 'none', reason: '这次派遣没有留下报告引用' });
    assert.equal(read.ok, false);
    assert.equal(read.code, 'none');
    assert.match(read.reason, /没有留下报告引用/);
  });
});

describe('questReportView and reportSnapshot', () => {
  it('shows a capture only to the attempt that made it', () => {
    const project = makeProject();
    put(project.root, '.work/oc/mod1.md', '# 战报\n\n正文\n\nVERDICT: PASS\n');
    const quest = { id: 'RPT-13', assignee: attempt() };
    const capture = captureAttemptReport({ config: project.config, quest });
    const withReport = { ...quest, attemptReport: capture };
    assert.equal(questReportView(withReport).source, 'delivery');
    const reassigned = { ...withReport, assignee: attempt({ attemptId: 'a2', at: '2026-09-15T00:00:00.000Z' }) };
    assert.equal(questReportView(reassigned), null, '新一次派遣不能继承上一轮的报告');
    assert.equal(questReportView(quest), null, '没有报告的旧任务保持可读');
  });

  it('prunes the snapshot field to reference and verdict only', () => {
    const project = makeProject();
    put(project.root, '.work/oc/mod1.md', '# 战报\n\n正文\n\nVERDICT: PASS\n');
    const quest = { id: 'RPT-14', assignee: attempt() };
    const capture = captureAttemptReport({ config: project.config, quest });
    const snapshot = reportSnapshot({ ...quest, attemptReport: capture });
    assert.deepEqual(Object.keys(snapshot).sort(), ['attemptId', 'bytes', 'capturedAt', 'digest', 'ref', 'sizeBytes', 'source', 'truncated', 'verdict']);
    assert.equal(snapshot.verdict, 'PASS');
    assert.equal(snapshot.summary, undefined, '快照里没有摘要正文');
    assert.equal(reportSnapshot({ id: 'RPT-15' }), null);
  });

  it('keeps a nothing-captured row out of the snapshot', () => {
    const project = makeProject();
    const quest = { id: 'RPT-16', assignee: attempt() };
    const capture = captureAttemptReport({ config: project.config, quest });
    assert.equal(capture.source, 'none');
    assert.equal(reportSnapshot({ ...quest, attemptReport: capture }), null);
  });
});
