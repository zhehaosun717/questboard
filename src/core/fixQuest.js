// FB2-12 item 4 (the other half of FB2-05's self-check): when the delivery self-check fails every round it
// was allowed, the board writes the small fix quest itself, so a one-line compile error does not have to
// wait for the owner to be at the keyboard. The card is never assigned here — the coordinator (or the
// owner) dispatches it, and rules.js coordinatorFastTrackRefusal is what lets the coordinator do that for
// this shape of card only.
//
// The brief is written by the board, like the review brief (reviewRequest.js) and for the same reason: the
// fix worker needs the check that failed and its own error text, and the project's brief directory is the
// only place a dispatchable brief may live. Nothing is invented: the file set comes from the failed quest's
// own editable files (its --files override, else its brief's file-list section), the check text from the
// configured post-delivery check, and the rounds from what the store already recorded. A fix that would
// touch more files than the fast-track limit is never generated at all — the caller sends the coordinator an
// inbox note naming the files instead.
import fs from 'node:fs';
import path from 'node:path';
import { withFileSets } from './briefs.js';
import { packageIdPattern } from './patterns.js';
import { COORDINATOR_MAX_FILES } from './rules.js';

const SUFFIXES = ['', ...'BCDEFGHJKLMNPQRSTUVWXYZ'];
const ROUNDS_MAX = 8;

/** FIX-<failed id>, then FIX-<failed id>B, C… — only ids the project's own package pattern accepts. */
export function pickFixQuestId(config, failedId, takenIds) {
  const pattern = packageIdPattern(config);
  for (const suffix of SUFFIXES) {
    const id = `FIX-${failedId}${suffix}`;
    if (pattern.test(id) && !takenIds.has(id)) return id;
  }
  return null;
}

/**
 * What the board would post for one failed quest, decided without touching disk: the id, the brief path,
 * the file set and the brief text — or, when it must not generate one, which of the two reasons applies
 * (too_many_files with the files it found, no_id when the project's own pattern cannot express a fix id).
 * `failed` is expected to be the enriched quest (withFileSets), so its .files is the real editable set.
 */
export function planFixQuest({ config, failed, checkCommand, takenIds, maxFiles = COORDINATOR_MAX_FILES }) {
  const [withFiles] = withFileSets(config, [failed]);
  const files = [...(withFiles.files || [])];
  if (files.length > maxFiles) return { ok: false, reason: 'too_many_files', files, maxFiles };
  const id = pickFixQuestId(config, failed.id, takenIds);
  if (!id) return { ok: false, reason: 'no_id', files, maxFiles };
  const dir = String(config.briefs.dispatchDirs[0]).replaceAll('\\', '/').replace(/\/$/, '');
  return {
    ok: true,
    id,
    files,
    brief: `${dir}/${id}-fix.md`,
    text: buildFixBrief({ fixId: id, failed: withFiles, checkCommand, files }),
  };
}

// The rounds the failed quest already recorded, as plain lines (round, exit code, summary). A quest whose
// checkResults are gone (a legacy row, or a failure that never went through the gate) simply has none: the
// brief then names the check and the log instead of pretending to quote an error it does not have.
function roundLines(failed) {
  const results = (failed.dispatches || []).at(-1)?.checkResults || failed.assignee?.checkResults || [];
  return results.slice(-ROUNDS_MAX).map((r) => `- 第 ${r.round} 轮（exit ${r.exitCode ?? '—'}）：${String(r.summary || '').trim()}`);
}

export function buildFixBrief({ fixId, failed, checkCommand, files }) {
  const lines = [
    `${fixId} — 修复 ${failed.id} 的自检失败（由看板自动生成的小修复卡）。`,
    '',
    `任务 ${failed.id} 交付后，项目的交付自检命令失败，重试机会用完，看板把这次修复单独开成一张卡。`,
    '只修这一个问题，不要顺手改别的东西，不要重构、不要加新功能。',
    '',
    '## 失败的检查',
    '',
    '```',
    checkCommand,
    '```',
    '',
  ];
  const rounds = roundLines(failed);
  if (rounds.length) {
    lines.push('看板记录到的每一轮输出（完整日志在同一次派遣的 .check.log 里）：', '', ...rounds, '');
  } else if (failed.lastDetail) {
    // No per-round rows left (a legacy row, or a board restart): the quest's own lastDetail is the same
    // failure text the board recorded, quoted as what it is rather than dressed up as a round table.
    lines.push('看板记录的失败详情：', '', '```text', failed.lastDetail, '```', '');
  } else {
    lines.push('看板没有留下这次自检的输出记录，请先手动跑一遍上面这条命令，看它报什么错。', '');
  }
  lines.push('## 原来的任务', '', `- 委托书：\`${failed.brief}\`（这次修复仍然按它的要求做）`, `- 标题：${failed.title}`, '');
  if (files.length) {
    lines.push('## Files you may edit', '', '只许改这些文件：', '');
    for (const file of files) lines.push(`- \`${file}\``);
  } else {
    lines.push('## Files you may edit', '', '原来那份委托书没有列出可改文件，范围以那次交付为准：只改让上面这条检查报错所必需的文件。');
  }
  lines.push(
    '',
    '## 做完怎么交',
    '',
    '改完再跑一遍上面那条检查命令，确认它通过；然后正常交付（看板会照常跑自检）。',
    '',
  );
  return lines.join('\n');
}

/**
 * Posts the fix quest for a failed one. Returns { ok: true, quest } or { ok: false, reason, detail, files }
 * — never a partial write: the brief file is written with 'wx' (never over another file) and removed again
 * if posting refuses it, so a refusal leaves the project exactly as it was. The board does not assign it.
 */
export function requestFixQuest({ config, store, failedId, checkCommand, by = 'board', maxFiles = COORDINATOR_MAX_FILES }) {
  const failed = store.get(failedId);
  if (!failed) return { ok: false, reason: 'no_failed_quest', detail: `看板上没有 ${failedId}，没法为它开修复卡` };
  const plan = planFixQuest({
    config,
    failed,
    checkCommand,
    takenIds: new Set(store.list().map((q) => q.id)),
    maxFiles,
  });
  if (!plan.ok) {
    return {
      ok: false,
      reason: plan.reason,
      files: plan.files,
      detail: plan.reason === 'too_many_files'
        ? `${failedId} 的可改文件有 ${plan.files.length} 个，超过快速通道上限 ${plan.maxFiles} 个，没有自动开修复卡`
        : `没有可用的修复卡编号：FIX-${failedId} 已被占用，这个项目的编号规则也不允许再加后缀`,
    };
  }
  const file = path.join(config.root, plan.brief);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, plan.text, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') return { ok: false, reason: 'brief_exists', files: plan.files, detail: `修复简报文件已经存在：${plan.brief}，不会覆盖它` };
    throw error;
  }
  const posted = store.post({
    package: plan.id,
    kind: 'code',
    brief: plan.brief,
    title: `${failed.id} 自检没过的小修复（${checkCommand}）`.slice(0, 120),
    priority: failed.priority,
    // The failed quest's own file set, as an explicit override: the fix card's scope is exactly the scope
    // the check failed in, and rules.js counts these same files for the coordinator fast track.
    files: plan.files,
    origin: 'post-delivery-check',
    check: checkCommand,
    by,
  });
  if (posted.errors) {
    fs.rmSync(file, { force: true });
    return { ok: false, reason: 'post_refused', files: plan.files, detail: `修复卡没发出去：${Object.values(posted.errors).join('；')}` };
  }
  return { ok: true, quest: posted.quest };
}
