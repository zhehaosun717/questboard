// Merge semantics for `roster import`. An old-generation roster file is a source of card facts, not a
// snapshot of this machine: cards are matched by stable id, locally customized env keys, variants and
// facts the file does not carry survive, and a merge never silently erases an existing card. A full
// replacement is the explicit `--replace` mode. Everything (merged roster, every status record) is
// validated before this planning step returns, so the caller's rule "nothing is written unless the whole
// plan is valid" holds; a failed import leaves roster and status log untouched.
//
// Status records keep one invariant, unconditionally: an import only ever adds a card's *first* status
// record. Once a card has any status history at all -- including an explicit `available` -- the import
// never appends another record for it, however new the incoming record or the source file's own
// modification time; there is no flag to force an override. A card's own status history existing (even a
// single `available` record) is not the same thing as a card merely defaulting to "available" for having
// no record at all -- only the latter is eligible to receive an imported initial status.
import { validateRoster } from './roster.js';
import { validateStatusRecord, foldStatuses } from './status.js';

// Key-sorted stringify: an env object equal in content never reads as "changed", whatever order it was typed in.
const stableJson = (value) => (value === undefined ? undefined : JSON.stringify(recurseSort(value)));
function recurseSort(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, recurseSort(v)]));
  }
  return value;
}

function mergeCard(existing, incoming) {
  const merged = { ...existing };
  const fields = [];
  for (const [field, value] of Object.entries(incoming)) {
    if (field === 'id') continue;
    if (field === 'env') {
      const env = { ...(existing.env || {}), ...value };
      if (stableJson(env) !== stableJson(existing.env)) {
        merged.env = env;
        fields.push('env');
      }
      continue;
    }
    if (stableJson(existing[field]) !== stableJson(value)) {
      if (value === undefined) delete merged[field];
      else merged[field] = value;
      fields.push(field);
    }
  }
  return { merged, fields };
}

function replacedFields(existing, incoming) {
  const fields = new Set(Object.keys(incoming).filter((f) => f !== 'id' && stableJson(existing[f]) !== stableJson(incoming[f])));
  for (const field of Object.keys(existing)) if (field !== 'id' && !(field in incoming)) fields.add(field);
  return [...fields];
}

// existing/incoming: { adventurers: [...] } validated shapes; statusRecords: split output -- the caller
// (commands.js) is responsible for what each record's `at`/`reason` says about how genuine its date is,
// since only the caller knows whether a per-card date came from the source file itself or is standing in
// for one; currentStatus: map of latest status records (foldStatuses) or an array of records.
export function planRosterImport({ existing, incoming, statusRecords = [], currentStatus = new Map(), replace = false }) {
  const incomingRoster = validateRoster(incoming); // a malformed file fails here, before anything else
  const records = statusRecords.map(validateStatusRecord); // all status records validated first

  const existingCards = existing.adventurers;
  const existingById = new Map(existingCards.map((a) => [a.id, a]));
  const incomingById = new Map(incomingRoster.adventurers.map((a) => [a.id, a]));
  const merged = [];
  const kept = [];
  const updated = [];
  const unchanged = [];
  const dropped = [];
  for (const card of existingCards) {
    const incomingCard = incomingById.get(card.id);
    if (!incomingCard) {
      if (replace) dropped.push(card.id);
      else {
        kept.push(card.id);
        merged.push(card);
      }
      continue;
    }
    if (replace) {
      const fields = replacedFields(card, incomingCard);
      if (fields.length) updated.push({ id: card.id, fields });
      else unchanged.push(card.id);
      merged.push({ ...incomingCard });
      continue;
    }
    const { merged: mergedCard, fields } = mergeCard(card, incomingCard);
    if (fields.length) updated.push({ id: card.id, fields });
    else unchanged.push(card.id);
    merged.push(mergedCard);
  }
  const added = [];
  for (const card of incomingRoster.adventurers) {
    if (!existingById.has(card.id)) {
      added.push(card.id);
      merged.push({ ...card });
    }
  }

  // A card's own status history existing at all -- current.has(id) -- is what disqualifies an import from
  // touching it, regardless of what status it currently holds. This is deliberately not a timestamp
  // comparison: file mtime (or any other fallback date) is never treated as authority over a real owner
  // decision, so a re-import after the file was merely touched, or an incoming status that happens to look
  // "newer", can never re-pause a card the owner un-paused or replace a paused/disabled card with anything.
  // Only a card with no status record at all -- genuinely new to status tracking -- receives its first one.
  const current = currentStatus instanceof Map ? currentStatus : foldStatuses(currentStatus);
  const toAppend = [];
  const statusSkipped = [];
  for (const record of records) {
    if (current.has(record.adventurerId)) statusSkipped.push(record.adventurerId);
    else toAppend.push(record);
  }

  return {
    mode: replace ? 'replace' : 'merge',
    // Every changed or added card here is `incomingCard` (already checked strictly above, in `incomingRoster`)
    // merged over `existing`; only a card this import never touched can still carry a name that policy now
    // rejects only without this project's `policy.cardEnvAllow`, which this planner never receives. Lenient
    // here matches `upsertAdventurer`: the entries this call actually changes are already checked in full.
    roster: validateRoster({ adventurers: merged }, { lenientEnv: true }),
    toAppend,
    statusSkipped,
    added,
    updated,
    unchanged,
    kept,
    dropped,
  };
}

// Per-card lines shared by dry runs and real imports: counts and changed field names only — never env
// keys or values. A preview and the run it previews always say the same thing.
export function importDetailLines(plan) {
  const lines = [`  ${plan.added.length} added, ${plan.updated.length} updated, ${plan.unchanged.length} unchanged, ${plan.kept.length} local cards kept`];
  if (plan.mode === 'replace' && plan.dropped.length) lines.push(`  ${plan.dropped.length} local cards will be erased: ${plan.dropped.join(', ')}`);
  for (const card of plan.updated) lines.push(`  ~ ${card.id}: ${card.fields.join(', ')}`);
  for (const id of plan.added) lines.push(`  + ${id}`);
  return lines;
}

// Dry-run text: the header, the shared detail, and the status-line summary.
export function importPlanText(plan) {
  const lines = [`${plan.mode === 'replace' ? 'replace' : 'merge'} plan: ${plan.roster.adventurers.length} cards after import`];
  lines.push(...importDetailLines(plan));
  if (plan.toAppend.length || plan.statusSkipped.length) {
    lines.push(`  ${plan.toAppend.length} status records to append${plan.statusSkipped.length ? `; ${plan.statusSkipped.length} skipped (card already has a status; imports never override an existing status): ${plan.statusSkipped.join(', ')}` : ''}`);
  }
  return lines.join('\n');
}

// --- FB2-07 item 2: opencode models --verbose import ----------------------------------------------
// The verbose listing is a header line (`provider/model`) followed by one pretty-printed JSON record
// per model. We parse the JSON blocks; a header line whose block fails to parse fails the whole import
// loudly rather than guessing.
export function parseOpencodeModelsVerbose(text) {
  const models = [];
  let buffer = [];
  let depth = 0;
  const flush = () => {
    if (!buffer.length) return;
    const raw = buffer.join(String.fromCharCode(10));
    buffer = [];
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('opencode models --verbose 里有一段 JSON 解析不了：' + raw.slice(0, 80)); }
    if (parsed && typeof parsed === 'object' && parsed.id) models.push(parsed);
  };
  for (const line of String(text || '').split(/\r?\n/)) {
    const opens = (line.match(/[{[]/g) || []).length;
    const closes = (line.match(/[}\]]/g) || []).length;
    if (!depth && !line.trim().startsWith('{')) continue; // a header like "opencode/big-pickle"
    buffer.push(line);
    depth += opens - closes;
    if (depth <= 0) { depth = 0; flush(); }
  }
  flush();
  if (!models.length) throw new Error('opencode models --verbose 的输出里没有解析到任何模型记录');
  return models;
}

// capability truth: text in, text out, tool calls. A record without a capabilities block is not proof of
// inability — it is kept and marked unverified instead of being silently dropped.
function capabilitiesOf(record) {
  const caps = record && record.capabilities;
  if (!caps || typeof caps !== 'object') return null;
  const input = caps.input || {};
  const output = caps.output || {};
  return { textIn: input.text === true, textOut: output.text === true, toolcall: caps.toolcall === true };
}

function opencodeCardId(record) {
  const raw = String(record.providerID || 'opencode') + '-' + String(record.id || '');
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
  return cleaned.slice(0, 48);
}

// planOpencodeImport turns parsed records into roster cards. filter=true keeps only text/text/toolcall
// models; retired (non-active) models import as verified:broken so the board never offers them as
// healthy; the caller decides what merge to do with the kept list.
export function planOpencodeImport({ models, lane, filter = true }) {
  if (!Array.isArray(models)) throw new Error('planOpencodeImport 需要 models 数组');
  if (typeof lane !== 'string' || !lane) throw new Error('planOpencodeImport 需要 --lane：卡得落在某个接入方式上');
  const kept = [];
  const filteredOut = [];
  const seen = new Set();
  for (const record of models) {
    const id = opencodeCardId(record);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const retired = record.status !== undefined && record.status !== 'active';
    const caps = capabilitiesOf(record);
    const usable = caps && caps.textIn && caps.textOut && caps.toolcall;
    if (filter && !retired && caps && !usable) { filteredOut.push(String(record.id)); continue; }
    const cost = record.cost || {};
    const free = Number(cost.input || 0) === 0 && Number(cost.output || 0) === 0;
    kept.push({
      id,
      name: String(record.name || record.id),
      provider: String(record.providerID || 'opencode'),
      // The opencode-level model id is what an oc lane's {model} template must fill; the upstream
      // api.id is kept as a note fact, never silently swapped in.
      model: String(record.id),
      family: String(record.family || record.id),
      lane,
      billing: free ? 'free' : 'metered',
      verified: retired ? 'broken' : (caps ? 'ok' : 'unverified'),
      importedFrom: 'opencode',
    });
  }
  return { kept, filteredOut };
}
