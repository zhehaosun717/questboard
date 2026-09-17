// Drift test: the docs (CLAUDE.md, README.md, README.zh-CN.md) name every event, lane-template
// placeholder and MCP tool the code can actually produce today. This scans the code for those names
// rather than hardcoding them, so a future addition or removal fails here instead of only in a
// human's memory of the audit that first noticed the gap.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

// A name counts as documented only as a whole token (not as a substring of a longer identifier or
// English word) -- e.g. "stalled" must not be satisfied by "installed", and "posted" must not be
// satisfied only by "review_posted".
function isDocumented(name, text) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(text);
}

function missing(names, text) {
  return [...new Set(names)].filter((name) => !isDocumented(name, text));
}

// Slices out one `## Heading` section (up to the next `## ` heading, or end of file) so a check
// against the "Events" section cannot pass merely because the name appears in unrelated prose.
function section(docText, heading) {
  const startIdx = docText.indexOf(heading);
  assert.ok(startIdx !== -1, `heading "${heading}" not found`);
  const rest = docText.slice(startIdx + heading.length);
  const endMatch = rest.match(/^## /m);
  return endMatch ? rest.slice(0, endMatch.index) : rest;
}

// --- Scan the code for what it can actually emit/accept/expose today ---

function extractEmittedEventNames(storeSrc, dispatcherSrc) {
  const names = new Set();
  const combined = `${storeSrc}\n${dispatcherSrc}`;

  // A literal passed directly as emitEvent's event argument: emitEvent(quest, 'name', ...)
  for (const m of combined.matchAll(/emitEvent\([^,]+,\s*'([a-zA-Z][a-zA-Z0-9_]*)'/g)) names.add(m[1]);

  // A ternary choosing the event name on one emitEvent(...) call, e.g. kind === 'review' ? 'review_posted' : 'posted'
  for (const line of combined.split('\n')) {
    if (!line.includes('emitEvent(')) continue;
    const ternary = line.match(/\?\s*'([a-zA-Z_]+)'\s*:\s*'([a-zA-Z_]+)'/);
    if (ternary) { names.add(ternary[1]); names.add(ternary[2]); }
  }

  // assign()'s own default event name (event = 'assigned'); dispatcher.js's override to 'dispatched'
  // is already caught above as a direct literal.
  const assignDefault = storeSrc.match(/\bevent\s*=\s*'([a-zA-Z_]+)'/);
  if (assignDefault) names.add(assignDefault[1]);

  // The STATUS_EVENTS lookup table's own values (delivered/failed/bounced/stalled/cancelled today).
  const statusEvents = storeSrc.match(/STATUS_EVENTS\s*=\s*\{([^}]*)\}/);
  if (statusEvents) for (const m of statusEvents[1].matchAll(/'([a-zA-Z_]+)'/g)) names.add(m[1]);

  return names;
}

const storeSrc = read('src/core/store.js');
const dispatcherSrc = read('src/server/dispatcher.js');
const emittedEventNames = [...extractEmittedEventNames(storeSrc, dispatcherSrc)];

// Any other quest status falls back to a dynamic `status_${status}` event name (store.js setStatus);
// that is documented as the fixed marker string "status_<status>", not as one of the literal names above.
const hasDynamicStatusEvent = /status_\$\{status\}/.test(storeSrc);

const configSrc = read('src/core/config.js');
const placeholdersMatch = configSrc.match(/PLACEHOLDERS\s*=\s*new Set\(\[([^\]]+)\]\)/);
assert.ok(placeholdersMatch, 'could not find PLACEHOLDERS in src/core/config.js');
const placeholders = [...placeholdersMatch[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);

const toolsSrc = read('src/mcp/tools.js');
const toolNames = [...toolsSrc.matchAll(/name:\s*'(questboard_[a-zA-Z_]+)'/g)].map((m) => m[1]);

describe('docs/contract drift', () => {
  it('scanned a non-trivial set of names to check (sanity on the scan itself)', () => {
    assert.ok(emittedEventNames.length >= 15, `expected at least 15 distinct emitted event names, found ${emittedEventNames.length}: ${emittedEventNames.join(', ')}`);
    assert.ok(placeholders.length >= 6, `expected at least 6 placeholders, found ${placeholders.length}: ${placeholders.join(', ')}`);
    assert.ok(toolNames.length >= 15, `expected at least 15 MCP tool names, found ${toolNames.length}: ${toolNames.join(', ')}`);
  });

  it('CLAUDE.md Contracts section names every event the code can emit today', () => {
    const contracts = section(read('CLAUDE.md'), '## Contracts');
    assert.deepEqual(missing(emittedEventNames, contracts), []);
    if (hasDynamicStatusEvent) assert.ok(contracts.includes('status_<status>'), 'CLAUDE.md Contracts must document the status_<status> fallback');
  });

  it('CLAUDE.md Contracts section names every lane-template placeholder', () => {
    const contracts = section(read('CLAUDE.md'), '## Contracts');
    assert.deepEqual(missing(placeholders, contracts), []);
  });

  it('CLAUDE.md states the real MCP tool count', () => {
    const claude = read('CLAUDE.md');
    assert.ok(claude.includes(`${toolNames.length} tools`), `expected CLAUDE.md to say "${toolNames.length} tools"`);
  });

  it('README.md Events section names every event the code can emit today', () => {
    const events = section(read('README.md'), '## Events');
    assert.deepEqual(missing(emittedEventNames, events), []);
    if (hasDynamicStatusEvent) assert.ok(events.includes('status_<status>'));
  });

  it('README.zh-CN.md 事件 section names every event the code can emit today', () => {
    const events = section(read('README.zh-CN.md'), '## 事件');
    assert.deepEqual(missing(emittedEventNames, events), []);
    if (hasDynamicStatusEvent) assert.ok(events.includes('status_<状态>'));
  });

  it('README.md MCP section documents every MCP tool name', () => {
    const mcp = section(read('README.md'), '## MCP');
    assert.deepEqual(missing(toolNames, mcp), []);
  });

  it('README.zh-CN.md MCP section documents every MCP tool name', () => {
    const mcp = section(read('README.zh-CN.md'), '## MCP');
    assert.deepEqual(missing(toolNames, mcp), []);
  });

  it('the check would fail if a name were removed from the docs', () => {
    // Proves the mechanism above is not vacuously true: missing() must flag a name that genuinely
    // is not in the text, using the exact same word-boundary logic the suite checks the real docs with.
    assert.deepEqual(missing(['posted', 'cancel_requested'], 'Events: posted, review_posted, dispatched.'), ['cancel_requested']);
    assert.deepEqual(missing(['stalled'], 'the CLIs it finds installed on this machine'), ['stalled']);
    assert.deepEqual(missing(['questboard_cancel_worker'], 'tools: questboard_list_quests, questboard_adopt'), ['questboard_cancel_worker']);
  });
});
