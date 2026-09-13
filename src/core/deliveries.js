// A server-API lane (OpenCode) leaves no .out/.md file the way file-based lanes do. When one of its
// workers delivers, its final assistant message is written to <deliveryDir>/<name>.md so the coordinator
// reads every lane's delivery the same way.
import fs from 'node:fs';
import path from 'node:path';
import { fillTemplate } from './config.js';

const NAME_PATTERN = /^[a-z0-9_]{1,48}$/;

export async function writeApiDelivery(config, laneId, name, { fetchImpl = fetch } = {}) {
  const lane = config.lanes[laneId];
  if (!lane || !lane.api) throw new Error(`lane ${laneId} has no api`);
  if (!lane.session || !lane.deliveryDir) throw new Error(`lane ${laneId} needs session.saveTo and deliveryDir to write deliveries`);
  if (!NAME_PATTERN.test(String(name))) throw new Error(`bad worker name ${name}`);
  const sessionFile = path.join(config.root, fillTemplate([lane.session.saveTo], { name }, `lanes.${laneId}.session.saveTo`)[0]);
  if (!fs.existsSync(sessionFile)) throw new Error(`no session file ${sessionFile}`);
  const session = fs.readFileSync(sessionFile, 'utf8').trim();
  const response = await fetchImpl(`${lane.api}/session/${encodeURIComponent(session)}/message`);
  if (!response.ok) throw new Error(`${laneId} answered ${response.status} for session ${session}`);
  const messages = await response.json();
  const last = (Array.isArray(messages) ? messages : []).filter((m) => m && m.info && m.info.role === 'assistant').at(-1);
  const text = last ? (last.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n\n').trim() : '';
  if (!text) throw new Error(`session ${session} has no final assistant text`);
  const out = path.join(config.root, lane.deliveryDir, `${name}.md`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${text}\n`, 'utf8');
  return out;
}
