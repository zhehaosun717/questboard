// Imports the first-generation roster format (a single roster.json), which mixed facts,
// statuses and dated owner notes, into the three layers: machine roster, status records, project policy.
// Nothing is dropped silently — every note that does not stay in the roster is reported.

const DATED_OR_PERSONAL = /\d{4}-\d{2}-\d{2}|owner|coordinator|（\d|\(\d/i;

export function splitLegacyRoster(legacy, { at = new Date().toISOString(), setBy = 'import' } = {}) {
  if (!legacy || !Array.isArray(legacy.adventurers)) throw new Error('legacy roster: adventurers array is required');
  const adventurers = [];
  const statusRecords = [];
  const report = [];
  for (const old of legacy.adventurers) {
    const { status, note, statusChangedAt, ...facts } = old;
    const entry = { ...facts };
    const noteText = typeof note === 'string' ? note.trim() : '';
    if (status && status !== 'available') {
      statusRecords.push({ at: statusChangedAt || at, adventurerId: old.id, status, reason: noteText, setBy });
      if (noteText) report.push({ id: old.id, note: noteText, movedTo: `status record (${status})` });
    } else if (noteText && DATED_OR_PERSONAL.test(noteText)) {
      report.push({ id: old.id, note: noteText, movedTo: 'dropped from roster (dated or personal); re-add as a status reason if still true' });
    } else if (noteText) {
      entry.notes = noteText;
    }
    adventurers.push(entry);
  }
  const policy = legacy.policy
    ? { bannedModelPatterns: legacy.policy.bannedModelPatterns || [], bannedAgents: legacy.policy.bannedAgents || [] }
    : { bannedModelPatterns: [], bannedAgents: [] };
  return { roster: { adventurers }, statusRecords, policy, report };
}
