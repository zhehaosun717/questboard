// FB2-13 item 2: questboard integrate <id> — apply the latest worktree patch to the main tree, remove
// the copy, stamp the attempt, emit integrate. A conflict (git apply refuses) keeps the copy and answers
// with git's own reason; nothing is recorded then, so a retry after manual cleanup still works. Kept out
// of dispatcher.js for the 800-line budget; the dispatcher exposes it under the same surface.
import { integratePatch } from '../core/worktrees.js';

export function createIntegrate({ config, store }) {
  return async function integrate(questId, by) {
    const quest = store.get(questId);
    if (!quest) return { status: 404, body: { error: 'quest not found' } };
    const attempt = [...(quest.dispatches || [])].reverse().find((entry) => entry.patch?.patchPath);
    if (!attempt) return { status: 409, body: { error: `${questId} 没有可合入的 patch（不是 worktree 交付，或那次交付没有任何改动）` } };
    if (attempt.integratedAt) return { status: 409, body: { error: `${questId} 的这次交付已合入（${attempt.integratedAt}），别重复合` } };
    let applied;
    try {
      applied = integratePatch({ config, quest });
    } catch (error) {
      return { status: 409, body: { error: `patch 合不进主树（副本保留着，冲突自己看）：${error.message}` } };
    }
    try {
      const updated = store.recordIntegrated(questId, attempt, by || 'owner', applied.files);
      return { status: 200, body: { quest: updated, integrated: applied } };
    } catch (error) {
      // The patch IS in the main tree now; only the booking failed. Loud and named, never a silent success.
      return { status: 503, body: { error: 'patch 已合入主树，但 integrate 登记没写成：' + error.message, applied: true } };
    }
  };
}
