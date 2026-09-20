// FB2-02 item 3: before a redo spawns, every earlier attempt's delivery artifacts (<name>.out/.exit/.md
// and friends in the lane's output/delivery dirs) are copied into a sibling <name>.bak-<timestamp> folder.
// Copy-only, never move or delete: a failed backup leaves the old delivery exactly where it was, and the
// dispatcher refuses to start the new attempt — a redo must never silently bury what came back last time.
import fs from 'node:fs';
import path from 'node:path';
import { realpathContainmentIssue } from './config.js';

export class DispatchBackupError extends Error {
  constructor(message, code = 'dispatch_backup') {
    super(message);
    this.name = 'DispatchBackupError';
    this.code = code;
  }
}

// Worker names come from workerName() (package-id characters only), but a hand-edited quests.jsonl row is
// not proof: anything that could escape the artifact dir is dropped from the backup list, not trusted.
const SAFE_NAME = /^[A-Za-z0-9_-]{1,128}$/;

export function backupPreviousAttempts({ config, quest, lane, now = new Date() }) {
  const directories = [...new Set([lane?.outputDir, lane?.deliveryDir]
    .filter((dir) => typeof dir === 'string' && dir.trim()))];
  const names = [...new Set((quest.dispatches || [])
    .map((dispatch) => dispatch && dispatch.name)
    .filter((name) => typeof name === 'string' && SAFE_NAME.test(name)))];
  if (!names.length || !directories.length) return [];
  // Colons and dots are awkward in folder names on Windows; the stamp stays sortable without them.
  const stamp = now.toISOString().replaceAll(/[:.]/g, '-');
  const backups = [];
  for (const name of names) {
    for (const dir of directories) {
      const absolute = path.resolve(config.root, dir);
      const issue = realpathContainmentIssue(config.root, absolute);
      if (issue) throw new DispatchBackupError(`交付目录不能用：${issue}`, 'backup_containment');
      if (!fs.existsSync(absolute)) continue;
      let files;
      try {
        files = fs.readdirSync(absolute)
          .filter((file) => file.startsWith(`${name}.`) && fs.statSync(path.join(absolute, file)).isFile());
      } catch (error) {
        throw new DispatchBackupError(`旧交付目录读取失败（${dir}）：${error.code || error.message}`);
      }
      if (!files.length) continue;
      const backupDir = path.join(absolute, `${name}.bak-${stamp}`);
      try {
        fs.mkdirSync(backupDir, { recursive: true });
        for (const file of files) fs.copyFileSync(path.join(absolute, file), path.join(backupDir, file));
      } catch (error) {
        throw new DispatchBackupError(`旧交付备份失败（${name} 的 ${files.length} 个文件）：${error.code || error.message}`);
      }
      backups.push({ name, directory: dir, backup: path.relative(config.root, backupDir).split(path.sep).join('/'), files: files.sort() });
    }
  }
  return backups;
}
