#!/usr/bin/env node
// questboard — local quest board for dispatching AI coding agents.
//
//   questboard init [<dir>] [--name "My Game"] [--port 6097] [--force]   (config + wrapper + brief + roster)
//        [--lane aider="aider --model {model}"]      add a lane for your own agent CLI; repeat for more
//   questboard serve [--project <dir>] [--port <n>]
//   questboard post --package RUN-4 --brief docs/briefs/RUN-4-x.md [--kind code|review|art|tool|owner]
//        [--parents A-1,B-2] [--conflicts C-3] [--lanes codex,agy] [--priority 1|2|3] [--needs-owner "question"] [--title "..."]
//   questboard list [--status posted]
//   questboard get <id> | show <id> [--json]                        (one quest: revision, worker, dispatch history, detail, files; --json for agents)
//   questboard release <id> --detail "how you confirmed the worker stopped"   (frees a stalled quest only; never kills or forces anything)
//   questboard status RUN-4 done|delivered|reviewing|needs_owner|owner_playtest|lane_limited|superseded|cancelled|failed [--detail "..."]
//        [--by coordinator|owner] [--evidence-ref kind=report,digest=<sha>,attemptId=<id> ...] [--note "..."]
//        (--evidence-ref/--note only take effect on `done`: they record an acceptance naming --by as the actor,
//        matched against the quest's own current-attempt evidence; refused if a ref does not match)
//   questboard ruling RUN-4 --text "..."
//   questboard update RUN-4 [--title "..."] [--brief docs/briefs/x.md] [--parents A-1,B-2] [--conflicts C-3]
//        [--lanes codex,agy] [--needs-owner "question"] [--if-revision 3] [--by who]
//        (correct title/brief/parents/conflicts/allowedLanes/needsOwner on a posted quest; refused while a worker holds its slot)
//   questboard assign RUN-4 --adventurer codex-luna [--request-key run4-a] [--if-revision 3]
//   questboard adopt RUN-3 --adventurer codex-luna --name run3      (a worker started by hand; runs nothing)
//   questboard doctor                                               (read-only setup check)
//   questboard card list | card add --id x --name X --provider P --lane codex --model m [--family m] [--variant high]
//   questboard card status <id> <status> [--reason "..."] [--by who]
//   questboard roster path | roster import <old roster.json> [--dry-run | --force (merge) | --replace --force (full swap)]
//   questboard board post --title "..." --body "..." [--tag t] [--author coordinator]   (--author defaults to coordinator)
//   questboard board reply --thread <id> --body "..." [--author coordinator] | list | read | close | inbox [options]
//   questboard watch [--from-start]                                 (one JSON event per line; for Monitor)
//   questboard mcp [--author coordinator] [--url http://127.0.0.1:6097]   (MCP server over stdio)
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
