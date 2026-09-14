// A running server over a temporary project and a temporary questboard home, with fake runners.
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../../src/server/server.js';
import { saveRoster } from '../../src/core/roster.js';
import { makeProject, tmpDir, CARDS } from '../helpers.js';

export async function startFixture({ runResult = () => ({ code: 0 }), writeDelivery, checkLaneServers } = {}) {
  const project = makeProject({ reviewPages: { dir: 'docs/art' } });
  project.write('docs/briefs/RUN-4-the-way-back.md', 'RUN-4 — the way back');
  project.write('docs/briefs/REVIEW-26-review-run-4.md', 'review');
  project.write('docs/briefs/RUN-9-not-posted.md', 'RUN-9 — nobody posted this');
  project.write('docs/art/robot/review_robot8.html', '<script type="application/json" id="review-data">{"page":"robot8","title":"机器人 8","sections":[{"id":"a"},{"id":"b"}]}</script>');
  const homeDir = tmpDir('qb-home-');
  const home = { home: homeDir, roster: path.join(homeDir, 'roster.json'), status: path.join(homeDir, 'status.jsonl') };
  saveRoster(home.roster, { adventurers: CARDS.map(({ status, ...card }) => card) });
  const calls = [];
  const holder = { lanes: null };
  const server = createServer({
    config: project.config, home, evidenceWaitMs: 0, getLanes: () => holder.lanes,
    writeDelivery: writeDelivery || (async (config, lane, name) => path.join(config.root, '.work', 'oc', `${name}.md`)),
    checkLaneServers,
    runners: {
      run: async (step) => { calls.push(step); return runResult(step); },
      session: async (step) => { calls.push(step); return { code: 0, session: 'ses_x' }; },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (route, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, body: json, text, headers: response.headers };
  };
  const events = () => fs.existsSync(project.config.paths.events) ? fs.readFileSync(project.config.paths.events, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const close = () => new Promise((resolve) => server.close(resolve));
  return { project, home, server, base, api, calls, holder, events, close };
}

export const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
