// A model review of returned work, requested from the board. Every dispatchable brief must live in a
// configured briefs directory (its text goes to a third-party model), so the board writes the review brief
// there itself and posts it as a `review` quest parented to the work. The existing rules then keep the work's
// author off the review, and assigning the reviewer goes through the normal dispatch path.
import fs from 'node:fs';
import path from 'node:path';
import { withFileSets } from './briefs.js';
import { packageIdPattern } from './patterns.js';

const CLOSED = new Set(['done', 'superseded', 'cancelled']);
const REVIEWABLE = new Set(['delivered', 'reviewing']);
const SUFFIXES = ['', ...'BCDEFGHJKLMNPQRSTUVWXYZ'];

export function activeReviewOf(quests, parentId) {
  return quests.find((q) => q.kind === 'review' && (q.parents || []).includes(parentId) && !CLOSED.has(q.status)) || null;
}

// REVIEW-<parent>, then REVIEW-<parent>B, C… — only ids the project's own package pattern accepts.
export function pickReviewId(config, parentId, takenIds) {
  const pattern = packageIdPattern(config);
  for (const suffix of SUFFIXES) {
    const id = `REVIEW-${parentId}${suffix}`;
    if (pattern.test(id) && !takenIds.has(id)) return id;
  }
  return null;
}

// Written like the reviews a coordinator hands out: a reviewer who did not write the work, checks it against
// its brief, changes nothing, and answers in a fixed shape. There is deliberately no "files you may edit"
// section, so the review holds no files and never queues behind the work it reviews.
export function buildReviewBrief({ reviewId, parent, note = '' }) {
  const last = (parent.dispatches || []).at(-1);
  const lines = [
    `${reviewId} — Review of ${parent.id}: ${parent.title}. Self-contained brief, written by the quest board.`,
    '',
    'You are the reviewer. You did not write this work. You check it against its brief and report; you do not fix, '
      + 'redesign or extend anything. Do not edit any file, do not create scratch files, do not commit. '
      + 'Do not use any popup, question, plan or subagent tool.',
    '',
    '## What to review',
    '',
    `- The brief the work was done against: \`${parent.brief}\`. Read it first; it is the standard.`,
  ];
  if (last) lines.push(`- Done by ${last.model} through the ${last.lane} lane (worker ${last.name}).`);
  if ((parent.files || []).length) {
    lines.push('- The files that brief allowed it to change:');
    for (const file of parent.files) lines.push(`  - \`${file}\``);
  }
  if (parent.lastDetail) lines.push('- The worker\'s own summary, as the board recorded it:', '', '~~~text', parent.lastDetail, '~~~');
  lines.push(
    '',
    '## Check',
    '',
    '1. Every requirement in the brief is met. Name each one that is not.',
    '2. The work stays inside the files the brief allowed. List every file outside that list.',
    '3. Nothing is faked: no placeholder or fallback value standing in for missing data, no test that asserts nothing.',
    '4. New or changed behaviour has a test that would fail without the change.',
  );
  if (note) lines.push('', '## The owner\'s note', '', note);
  lines.push(
    '',
    '## Report in exactly this shape and nothing else',
    '',
    '```',
    'PASS — <one line per requirement you verified>',
    'FINDINGS (numbered, each: file:line / what is wrong / why it matters)',
    'VERDICT: PASS | PASS WITH FINDINGS | FAIL',
    '```',
    '',
  );
  return lines.join('\n');
}

export function requestReview({ config, store, parentId, note = '', by = 'owner' }) {
  const parent = store.get(parentId);
  if (!parent) return { status: 404, body: { error: 'quest not found' } };
  if (parent.kind === 'owner') return { status: 409, body: { error: `${parentId} 是你亲自做的任务，不派模型审核` } };
  if (!REVIEWABLE.has(parent.status)) {
    return { status: 409, body: { error: `${parentId} 现在是「${parent.status}」，只有已交付或审核中的委托才能派模型审核` } };
  }
  const quests = store.list();
  const active = activeReviewOf(quests, parentId);
  if (active) return { status: 409, body: { error: `${parentId} 已经有审核委托 ${active.id}，先处理它`, review: active } };
  const reviewId = pickReviewId(config, parentId, new Set(quests.map((q) => q.id)));
  if (!reviewId) {
    return { status: 409, body: { error: `没有可用的审核委托编号：REVIEW-${parentId} 已被占用，这个项目的编号规则也不允许再加后缀` } };
  }

  const dir = String(config.briefs.dispatchDirs[0]).replaceAll('\\', '/').replace(/\/$/, '');
  const brief = `${dir}/${reviewId}-review.md`;
  const file = path.join(config.root, brief);
  const [withFiles] = withFileSets(config, [parent]);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buildReviewBrief({ reviewId, parent: withFiles, note }), { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') return { status: 409, body: { error: `简报文件已经存在：${brief}，不会覆盖它` } };
    throw error;
  }

  const posted = store.post({
    package: reviewId,
    kind: 'review',
    brief,
    title: `审核 ${parentId}：${parent.title}`.slice(0, 120),
    parents: [parentId],
    priority: parent.priority,
    by,
  });
  if (posted.errors) {
    fs.rmSync(file, { force: true });
    return { status: 400, body: { error: 'validation failed', fields: posted.errors } };
  }
  // 审核中, keeping the worker's summary: a bare status change would replace the detail the receipt shows.
  const quest = parent.status === 'reviewing'
    ? parent
    : store.setStatus(parentId, 'reviewing', { detail: parent.lastDetail || '', by });
  return { status: 201, body: { review: posted.quest, quest } };
}
