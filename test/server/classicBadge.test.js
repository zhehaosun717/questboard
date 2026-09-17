import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// F3: the classic page's roster badge (public/quests.app.js, `derivedNote`) must say the same thing as the
// React board's CardBadge.derivedNote in all three cases — reset unknown, reset in the future, reset already
// passed — not only the unknown case. There is no module boundary to import across (quests.app.js is a
// browser IIFE, not a module), so this extracts the real `derivedNote` function text out of the shipped file
// and runs it, the way the round-1 review's headless-Chromium check did, without needing a browser here.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.join(HERE, '..', '..', 'public', 'quests.app.js');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

function extractDerivedNote() {
  const match = SOURCE.match(/function derivedNote\(derived\) \{\r?\n(?:.*\r?\n)*?  \}/);
  assert.ok(match, 'derivedNote function not found in public/quests.app.js');
  // eslint-disable-next-line no-new-func
  return new Function(`return (${match[0]});`)();
}

describe('classic board badge: derivedNote matches CardBadge.derivedNote (F3)', () => {
  const derivedNote = extractDerivedNote();

  it('shows only the reason for a reset that has already passed — no promise of automatic recovery', () => {
    const text = derivedNote({ reason: '限额窗口已过，尚未验证可用', resetsAt: '2020-01-01T00:00:00.000Z' });
    assert.equal(text, '限额窗口已过，尚未验证可用');
  });

  it('adds the unknown-reset clause when resetsAt is missing', () => {
    const text = derivedNote({ reason: 'codex 限额中', resetsAt: null });
    assert.equal(text, 'codex 限额中（重置时间未知，成功一次或你手动确认后恢复）');
  });

  it('adds the future-reset clause when resetsAt is still ahead, matching the React wording exactly', () => {
    const text = derivedNote({ reason: 'codex 限额中，10:50 AM 恢复', resetsAt: '2099-01-01T00:00:00.000Z' });
    assert.equal(text, 'codex 限额中，10:50 AM 恢复（自动判断：到点后不再算限额，但额度没有核实过）');
  });
});
