#!/usr/bin/env node
// questboard — local quest board for dispatching AI coding agents.
//
//   questboard serve [--project <dir>] [--port <n>]
//   questboard post --package RUN-4 --brief docs/briefs/RUN-4-x.md [--kind code|review|art|tool|owner]
//        [--parents A-1,B-2] [--conflicts C-3] [--lanes codex,agy] [--priority 1|2|3] [--needs-owner "question"] [--title "..."]
//   questboard list [--status posted]
//   questboard status RUN-4 done|delivered|reviewing|needs_owner|owner_playtest|lane_limited|superseded|cancelled|failed [--detail "..."]
//   questboard ruling RUN-4 --text "..."
//   questboard assign RUN-4 --adventurer codex-luna
//   questboard adopt RUN-3 --adventurer codex-luna --name run3      (a worker started by hand; runs nothing)
//   questboard card list | card status <id> <status> [--reason "..."] [--by who]
//   questboard roster path | roster import <old roster.json> [--force]
//   questboard board post|reply|list|read|close|inbox [options]
//   questboard watch [--from-start]                                 (one JSON event per line; for Monitor)
//
// Every command finds questboard.config.json in the current folder or a parent, or takes --project <dir>.
import { commands } from './commands.js';

const [name, ...args] = process.argv.slice(2);
if (!commands[name]) {
  process.stderr.write(`usage: questboard <${Object.keys(commands).join('|')}> [options]\n`);
  process.exit(2);
}
Promise.resolve(commands[name](args)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
