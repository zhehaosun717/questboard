// Same-origin JSON endpoints for previewing and applying roster batch operations. The route owns no roster
// policy: it delegates the validation, hold checks and immutable writes to core/rosterBulk.js.
import { readJsonBody, sendJson, writeRefusal } from './http.js';
import { applyRosterBulk, previewRosterBulk } from '../core/rosterBulk.js';
import { loadRosterOrEmpty, saveRoster } from '../core/roster.js';
import { effectiveRoster } from '../core/overlay.js';
import { applyStatuses } from '../core/status.js';

const BODY_LIMIT = 256 * 1024;

function failure(response, error) {
  if (error.code === 'request_too_large') { sendJson(response, 413, { error: '请求内容太大' }); return; }
  if (error.code === 'stale_revision') {
    sendJson(response, 409, { error: 'stale', revision: error.revision, reasons: [{ code: error.code, message: error.message }] });
    return;
  }
  sendJson(response, 400, { error: error.message, ...(error.fields && Object.keys(error.fields).length ? { fields: error.fields } : {}) });
}

// `cardEnvAllow` is the project's policy.cardEnvAllow list; without it only the built-in env shapes pass.
export function createRosterBulkRoutes({ rosterFile, statusLog, getQuests = () => [], getLanes = () => null, cardEnvAllow = [] } = {}) {
  if (!rosterFile) throw new Error('roster bulk routes need a roster file');

  const getEffectiveRoster = () => {
    const roster = loadRosterOrEmpty(rosterFile);
    return effectiveRoster(applyStatuses(roster.adventurers, statusLog.current()), getLanes());
  };

  const getQuotaEvidenceRoster = () => {
    const roster = loadRosterOrEmpty(rosterFile);
    const current = applyStatuses(roster.adventurers, statusLog.current());
    // The regular overlay preserves every non-available manual status and therefore cannot attach derived
    // evidence to those cards. Probe those cards as available, without changing the real status layer, so
    // bulk available cannot become an implicit quota acknowledgement.
    const probe = current.map((card) => card.status === 'available' ? card : {
      ...card,
      status: 'available',
      statusSince: null,
      statusReason: '',
      statusSetBy: null,
    });
    return effectiveRoster(probe, getLanes());
  };

  async function handle(request, response, url, parts) {
    const operation = parts[3];
    if (parts.length !== 4 || parts[0] !== 'api' || parts[1] !== 'roster' || parts[2] !== 'bulk' || !['preview', 'apply'].includes(operation)) return false;
    if (request.method !== 'POST') { sendJson(response, 404, { error: 'not found' }); return true; }
    const refusal = writeRefusal(request);
    if (refusal) { sendJson(response, 403, { error: refusal }); return true; }
    try {
      const body = await readJsonBody(request, BODY_LIMIT);
      const common = { rosterFile, statusLog, getQuests, getEffectiveRoster, getQuotaEvidenceRoster, request: body, load: () => loadRosterOrEmpty(rosterFile), save: saveRoster, cardEnvAllow };
      const result = operation === 'preview'
        ? previewRosterBulk({ roster: loadRosterOrEmpty(rosterFile), statusRecords: statusLog.records(), quests: getQuests(), effectiveRoster: getEffectiveRoster(), quotaEvidenceRoster: getQuotaEvidenceRoster(), request: body, cardEnvAllow })
        : await applyRosterBulk(common);
      sendJson(response, 200, result);
    } catch (error) {
      failure(response, error);
    }
    return true;
  }

  return { handle };
}
