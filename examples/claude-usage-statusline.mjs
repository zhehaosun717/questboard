import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Claude Code Status-Line Usage Snapshot for Questboard
 *
 * Copies quota windows (five_hour, seven_day, spend_limit) from Claude Code's
 * statusLine session data into <QUESTBOARD_HOME>/usage/claude.json
 * (default: ~/.questboard/usage/claude.json).
 *
 * Questboard itself never runs this script and never edits any file under
 * ~/.claude. Adding the statusLine command below is an opt-in step you do
 * yourself. QUESTBOARD_HOME must be the same for Claude Code and the board,
 * or the board will look in the wrong directory.
 *
 * How to enable (pick ONE option):
 *
 * Option 1 - keep your existing status-line script (recommended if you already
 * have one): import the two helper functions from this file inside your own
 * script and call them with the stdin text Claude Code gives you. The board
 * never runs or chains your script; the chaining happens on your side.
 *
 *   import { extractClaudeSnapshot, writeClaudeSnapshot } from '<path-to-questboard>/examples/claude-usage-statusline.mjs';
 *   // snapshot = extractClaudeSnapshot(stdinText); writeClaudeSnapshot(snapshot);
 *
 *   Windows note: an absolute ESM import must be a file:/// URL, for example
 *   'file:///C:/path-to-questboard/examples/claude-usage-statusline.mjs'. A plain 'C:\...' path is
 *   rejected by Node's ESM loader.
 *
 * Option 2 - replace your status line with this script and pass your status
 * text as arguments (printed through unchanged):
 *
 *   {
 *     "statusLine": {
 *       "type": "command",
 *       "command": "node \"<path-to-questboard>/examples/claude-usage-statusline.mjs\" \"[your status text]\""
 *     }
 *   }
 *
 * WARNING: "statusLine" is a single settings key. If you already have a
 * statusLine command, pasting the block above REPLACES it. Use Option 1 to
 * keep your existing command (your script imports these helpers and stays in
 * charge of what is displayed).
 *
 * Without arguments this script still prints a short Chinese line so the
 * status line is never blank: "Claude 用量快照已更新" after a fresh snapshot
 * was saved, "Claude 用量快照未更新" otherwise. It never prints session,
 * model, working-directory, transcript, or cost data.
 *
 * Questboard never automatically edits ~/.claude/settings.json.
 * You must add this configuration yourself.
 */

/**
 * Extracts and filters rate_limits from Claude Code statusLine stdin data.
 * Pure function with no side effects. Only finite numbers are accepted.
 *
 * @param {string|object} input Stdin JSON string or parsed object
 * @param {number|string|Date} [now=Date.now()] Timestamp for capturedAt
 * @returns {object|null} Filtered snapshot with schema 1, or null if rate_limits is absent
 */
export function extractClaudeSnapshot(input, now = Date.now()) {
  let data = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return null;
    try {
      data = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }

  const rawLimits = data.rate_limits;
  if (!rawLimits || typeof rawLimits !== 'object' || Array.isArray(rawLimits)) {
    // Writes nothing when rate_limits is absent (so an older snapshot is not overwritten with empty)
    return null;
  }

  const rate_limits = {};

  // Copy ONLY five_hour, seven_day, and spend_limit
  for (const key of ['five_hour', 'seven_day', 'spend_limit']) {
    const windowObj = rawLimits[key];
    if (windowObj && typeof windowObj === 'object' && !Array.isArray(windowObj)) {
      const used = typeof windowObj.used_percentage === 'number' && Number.isFinite(windowObj.used_percentage)
        ? windowObj.used_percentage
        : null;
      const resetsAt = typeof windowObj.resets_at === 'number' && Number.isFinite(windowObj.resets_at)
        ? Math.floor(windowObj.resets_at)
        : null;

      if (used !== null && resetsAt !== null) {
        rate_limits[key] = {
          used_percentage: used,
          resets_at: resetsAt,
        };
      }
    }
  }

  // If rate_limits has no valid windows, write nothing so older snapshot is not overwritten
  if (Object.keys(rate_limits).length === 0) {
    return null;
  }

  const capturedAt = new Date(now).toISOString();

  return {
    schema: 1,
    capturedAt,
    rate_limits,
  };
}

// The snapshot-path rule lives in the board at src/usage/claudeStatusline.js (which delegates to
// src/core/home.js questboardHome); this inline copy exists only because a copied-out status-line script
// cannot import from the repo. Keep the two in step: an absolute path.resolve of QUESTBOARD_HOME (or of
// <homedir>/.questboard), then 'usage/claude.json'. test/usage/claude-statusline-followups.test.js proves
// the two functions agree.
export function getClaudeSnapshotPath({ homedir, env = process.env } = {}) {
  const baseHome = env?.QUESTBOARD_HOME
    ? env.QUESTBOARD_HOME
    : path.join(homedir || os.homedir(), '.questboard');
  return path.join(path.resolve(baseHome), 'usage', 'claude.json');
}

/**
 * Atomically writes a snapshot to <QUESTBOARD_HOME>/usage/claude.json via a temporary file.
 *
 * @param {object} snapshot The filtered snapshot
 * @param {object} [options]
 * @returns {boolean} True if written successfully, false otherwise
 */
export function writeClaudeSnapshot(snapshot, { homedir, env = process.env } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const targetFile = getClaudeSnapshotPath({ homedir, env });
  const dir = path.dirname(targetFile);
  let tempFile = null;

  try {
    fs.mkdirSync(dir, { recursive: true });
    tempFile = path.join(dir, `.claude.json.tmp.${process.pid}.${Date.now()}`);
    fs.writeFileSync(tempFile, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    fs.renameSync(tempFile, targetFile);
    return true;
  } catch {
    if (tempFile && fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
    }
    return false;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
  } catch {
    return false;
  }
}

export async function main() {
  let stdinText = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      stdinText += chunk;
    }
  } catch {
    // Stdin read failure: continue to status line output
  }

  let snapshotWritten = false;
  if (stdinText) {
    try {
      const snapshot = extractClaudeSnapshot(stdinText);
      if (snapshot) {
        snapshotWritten = writeClaudeSnapshot(snapshot);
      }
    } catch {
      // Never crash the status line output
    }
  }

  const statusText = process.argv.slice(2).join(' ');
  if (statusText) {
    // Print the owner's normal status text passed through unchanged
    process.stdout.write(statusText + (statusText.endsWith('\n') ? '' : '\n'));
    return;
  }

  // No status text given: still print a short line so the status line is never blank.
  // These two lines are fixed, truthful text; they never include session data.
  process.stdout.write(snapshotWritten ? 'Claude 用量快照已更新\n' : 'Claude 用量快照未更新\n');
}

if (isMainModule()) {
  main();
}
