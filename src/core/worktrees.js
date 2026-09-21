// FB2-13 (条目 29): opt-in worktree dispatch. When policy.worktrees.enabled, each attempt edits its own
// detached copy of the project; delivery is the copy's diff against the base commit, written as a patch;
// integrate applies that patch to the main tree and removes the copy. Everything here is git + plain file
// copies — nothing project-specific, and every failure throws with the git stderr attached, never a guess.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE } from './config.js';

const run = (cwd, args) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim();
    throw new Error(`git ${args.join(' ')} 失败：${detail || '没有输出'}`);
  }
};

// Creates <root>/<dir>/<name> as a detached worktree at base and returns { path, base } (the resolved sha,
// so a moving ref like HEAD is pinned at dispatch time). The wrapper resolves questboard.config.json from
// its own cwd and the copy only holds tracked files, so the config is copied in with its registry rewritten
// to the MAIN project's absolute registry (the worker must register where the collector reads), and the
// brief is copied to the same relative path (untracked briefs never arrive via checkout).
export function prepareWorktree({ config, name, brief }) {
  const { dir, base } = config.policy.worktrees;
  try {
    run(config.root, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    throw new Error('项目不是 git 仓库，worktree 派单用不了；关掉 policy.worktrees 或先 git init');
  }
  const baseSha = run(config.root, ['rev-parse', base]);
  const copyPath = path.join(config.root, dir, name);
  if (fs.existsSync(copyPath)) throw new Error(`副本目录已存在：${copyPath}，先 integrate 或手动删掉`);
  run(config.root, ['worktree', 'add', '--detach', copyPath, baseSha]);
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(config.root, CONFIG_FILE), 'utf8'));
    raw.registry = config.paths.registry;
    fs.writeFileSync(path.join(copyPath, CONFIG_FILE), JSON.stringify(raw, null, 2));
    if (brief) {
      const briefSource = path.join(config.root, brief);
      if (!fs.existsSync(briefSource)) throw new Error(`brief 文件不存在：${brief}`);
      const briefTarget = path.join(copyPath, brief);
      fs.mkdirSync(path.dirname(briefTarget), { recursive: true });
      fs.copyFileSync(briefSource, briefTarget);
    }
  } catch (error) {
    // Half-prepared copy must not linger looking valid.
    removeWorktree({ config, copyPath });
    throw error;
  }
  return { path: copyPath, base: baseSha, ...(brief ? { brief } : {}) };
}

// Removes a copy; failure (already gone, git hiccup) is only ever cleanup, so it is ignored.
export function removeWorktree({ config, copyPath }) {
  try {
    run(config.root, ['worktree', 'remove', '--force', copyPath]);
  } catch { /* best effort */ }
}

// The delivery side: everything the worker changed in the copy, staged (the copy is disposable, so
// git add -A is honest there) and diffed against the pinned base. Returns null when nothing changed —
// an empty patch is a fact the caller reports, not a file worth writing.
export function capturePatch({ config, attempt }) {
  const { path: copyPath, base } = attempt.worktree;
  // The copied config and brief are dispatch scaffolding, not the worker's edits — excluded from the patch
  // (a config change must go through the owner / the settings page, never ride a delivery).
  const excludes = [':(exclude)' + CONFIG_FILE, ...(attempt.worktree.brief ? [':(exclude)' + attempt.worktree.brief] : [])];
  run(copyPath, ['add', '-A', '--', '.', ...excludes]);
  const patch = run(copyPath, ['-c', 'core.fileMode=false', 'diff', '--cached', base]);
  const names = run(copyPath, ['-c', 'core.fileMode=false', 'diff', '--cached', '--name-status', base]);
  const files = names ? names.split('\n').map((line) => {
    const [status, ...rest] = line.split('\t');
    return { status, path: rest.join('\t') };
  }) : [];
  if (!files.length) return null;
  const patchDir = path.join(config.paths.data, 'patches');
  fs.mkdirSync(patchDir, { recursive: true });
  const patchFile = path.join(patchDir, `${attempt.name}.patch`);
  fs.writeFileSync(patchFile, patch.endsWith('\n') ? patch : patch + '\n');
  return { patchPath: patchFile, files };
}

// Applies the attempt's patch to the main tree. Throws with git's own stderr on conflict — the copy is
// kept so the conflict can be inspected. On success the copy is removed.
export function integratePatch({ config, quest }) {
  const attempt = [...(quest.dispatches || [])].reverse().find((entry) => entry.patch?.patchPath);
  if (!attempt) throw new Error(`${quest.id} 没有可合入的 patch（不是 worktree 交付，或交付时没有任何改动）`);
  const { patchPath } = attempt.patch;
  if (!fs.existsSync(patchPath)) throw new Error(`patch 文件不存在：${patchPath}`);
  run(config.root, ['apply', '--check', patchPath]);
  run(config.root, ['apply', patchPath]);
  if (attempt.worktree?.path) removeWorktree({ config, copyPath: attempt.worktree.path });
  return { files: attempt.patch.files.map((file) => file.path), attemptId: attempt.attemptId };
}
