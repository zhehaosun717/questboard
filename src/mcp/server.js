// `questboard mcp`: the questboard tools for any MCP client (Claude Code, Codex, OpenCode, ...).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHandler, serveStdio } from './protocol.js';
import { createTools } from './tools.js';
import { homePaths } from '../core/home.js';
import { request } from '../cli/client.js';

const PACKAGE = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'));

export function createQuestboardMcp({ config, base, author, home = homePaths(), requestImpl = request }) {
  return createMcpHandler({
    name: 'questboard',
    version: PACKAGE.version,
    instructions: [
      `Quest board for ${config.name}. Quests are briefs; cards are models reachable through lanes (${Object.keys(config.lanes).join(', ')}).`,
      'The owner assigns cards by dragging on the board. Post quests with parents, conflicts and allowed lanes; adopt workers you start by hand; set quest status after you verify a delivery.',
      `Writes need the board server running at ${base} (start it with: questboard serve).`,
    ].join(' '),
    tools: createTools({ config, base, author, home, request: requestImpl }),
  });
}

export function runMcp({ config, base, author }) {
  process.stderr.write(`questboard mcp: ${config.name}, server ${base}, author ${author}\n`);
  return serveStdio(createQuestboardMcp({ config, base, author }));
}
