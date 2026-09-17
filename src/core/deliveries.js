// A server-API lane (OpenCode) leaves no .out/.md file the way file-based lanes do. When one of its
// workers delivers, its final assistant message is written to <deliveryDir>/<name>.md so the coordinator
// reads every lane's delivery the same way.
import fs from 'node:fs';
import path from 'node:path';
import { fillTemplate } from './config.js';
import { protocolFor } from '../lanes/protocols.js';

const NAME_PATTERN = /^[a-z0-9_]{1,48}$/;

// Errors carrying one of these codes mean "not done yet, ask again later" — the session is still running,
// or the API that would tell us otherwise did not answer. Every other error (misconfiguration, a bad
// name, a completed session with nothing to deliver) is terminal: retrying it changes nothing.
export const TRANSIENT_DELIVERY_CODES = new Set(['STILL_RUNNING', 'BAD_RESPONSE', 'FETCH_FAILED']);

const DELIVERY_FETCH_TIMEOUT_MS = 3000;

export async function writeApiDelivery(config, laneId, name, { fetchImpl = fetch, timeout = DELIVERY_FETCH_TIMEOUT_MS } = {}) {
  const lane = config.lanes[laneId];
  const protocol = lane ? protocolFor(lane) : null;
  if (!lane || !protocol) throw new Error(`lane ${laneId} has no api`);
  if (!lane.session || !lane.deliveryDir) throw new Error(`lane ${laneId} needs session.saveTo and deliveryDir to write deliveries`);
  if (!NAME_PATTERN.test(String(name))) throw new Error(`bad worker name ${name}`);
  const sessionFile = path.join(config.root, fillTemplate([lane.session.saveTo], { name }, `lanes.${laneId}.session.saveTo`)[0]);
  if (!fs.existsSync(sessionFile)) throw new Error(`no session file ${sessionFile}`);
  const session = fs.readFileSync(sessionFile, 'utf8').trim();
  // The bounded read (URL shape, transport, timeout/abort handling) lives on the protocol entry
  // (src/lanes/protocols.js), not here — a second protocol needs no changes in this file (M2).
  const messages = await protocol.fetchMessages(fetchImpl, lane, session, { timeout, laneId });
  const text = protocol.parseDelivery(messages, session);
  const out = path.join(config.root, lane.deliveryDir, `${name}.md`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${text}\n`, 'utf8');
  return out;
}
