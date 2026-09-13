# questboard

A local quest board for dispatching AI coding agents across CLIs and providers.

You write a brief. It appears on the board as a quest. Every model you can use — through Codex CLI, Claude
Code, OpenCode, Google's agy, the DeepSeek harness, or any script you configure — is a card. Drag a card onto
a quest and questboard runs that lane's script headless. **Before you drop, it shows whether the card may
take the quest and why not**:

- the model is limited, out of balance or paused (with since when and why);
- the project does not allow that lane for this quest;
- the card is already running its parallel limit;
- a review would go to the same model family that wrote the code under review (checked across providers
  and the whole ancestor chain);
- another running quest edits the same files (read from each brief's "Files you may edit" list) — shown as
  a queue, one at a time;
- a verification lock is in place, the brief is missing, or an owner ruling is still open.

A coordinator agent can post quests, adopt workers it started by hand, and tail an NDJSON events file.
Worker results flow back into quest status automatically, and usage limits heal by themselves when they
reset.

Status: early. Phase 1 (core, server, CLI) works and is tested; MCP server, the Tauri desktop app and the
integrated usage / settings / model-config tabs are next.

## Requirements

- Node 22 or newer. No runtime dependencies.
- On Windows, Git Bash for `.sh` lane scripts (plain `bash` there is often WSL). Set `"bash"` in the
  project config or `QUESTBOARD_BASH` if it is not in a standard location.

## Three kinds of data

| Where | What | Shared by |
|:---|:---|:---|
| `~/.questboard/roster.json` (or `QUESTBOARD_HOME`) | Cards: id, name, provider, lane, model, family, variant, agent, billing, parallel limit, strengths, generic notes | every project on the machine |
| `~/.questboard/status.jsonl` | Status records: `{at, adventurerId, status, reason, setBy}`. A card without records is available | every project |
| `<project>/questboard.config.json` | Brief folders and id pattern, lane commands, output folders, events/registry/lock paths, banned models | one project |

Dated decisions ("paused on 9/12 because it costs too much") are status records, never roster text, so the
roster stays reusable.

## Project config

See [`examples/basic/questboard.config.json`](examples/basic/questboard.config.json). A lane is a
command template plus where its workers can be observed:

```json
"codex": {
  "run": ["tools/codex-run.sh", "{name}", "{brief}", "{model}", "{variant}"],
  "outputDir": ".claude/codex"
}
```

Placeholders: `{name}` (unique worker name), `{brief}`, `{model}`, `{variant}`, `{agent}`, `{package}`. A
placeholder without a value is an error, never an empty string. `.sh` commands run under Git Bash, `node`
under the current Node. File lanes write `<outputDir>/<name>.out` while running, `<name>.exit` when done,
and optionally `<name>.md` as the report. Server lanes (OpenCode) set `api`, a `session` step and a
`deliveryDir`; their final message is written to `<deliveryDir>/<name>.md` before `delivered` is announced.
`serialize` runs one dispatch at a time; `spacingMs` spaces starts; `defaultModel` labels old registry rows.

The project's own scripts register each dispatch in the registry file (one JSON line with `event:
"dispatch"`, `package`, `lane`, `model`, `name`, and `session` for server lanes). That registry is how the
board sees workers — including ones started by hand.

## CLI

```text
questboard serve [--project <dir>] [--port <n>]
questboard post --package RUN-4 --brief docs/briefs/RUN-4-x.md [--kind code|review|art|tool|owner]
     [--parents A-1] [--conflicts B-2] [--lanes codex,agy] [--priority 1|2|3] [--needs-owner "question"]
questboard list | status <id> <status> | ruling <id> --text ... | assign <id> --adventurer <card>
questboard adopt <id> --adventurer <card> --name <worker>
questboard card list | card status <card> <available|limited|broke|paused|disabled> --reason "..."
questboard roster path | roster import <old roster.json>
questboard board post|reply|list|read|close|inbox
questboard watch [--from-start]
```

## MCP

`questboard mcp` is an MCP server over stdio, so any agent can use the board as tools instead of shell
commands: `questboard_list_quests`, `questboard_get_quest` (with who may take it and why not),
`questboard_post_quest`, `questboard_set_quest_status`, `questboard_record_ruling`, `questboard_assign`,
`questboard_adopt`, `questboard_list_cards`, `questboard_set_card_status`, `questboard_events`,
`questboard_board_post`, `questboard_board_reply`, `questboard_board_inbox`. Writes go through the running
board server; start it with `questboard serve` first.

Claude Code:

```text
claude mcp add questboard -- node /path/to/questboard/src/cli/questboard.js mcp --project /path/to/game --author coordinator
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.questboard]
command = "node"
args = ["/path/to/questboard/src/cli/questboard.js", "mcp", "--project", "/path/to/game", "--author", "coordinator"]
```

OpenCode (`opencode.json`):

```json
{ "mcp": { "questboard": { "type": "local", "command": ["node", "/path/to/questboard/src/cli/questboard.js", "mcp", "--project", "/path/to/game"] } } }
```

MCP cannot push events, so a coordinator that wants to react the moment a worker delivers should still
tail the events file with `questboard watch`; `questboard_events` with `since` is the polling alternative.

## Events

`<events file>` gets one line per change: `{at, event, package, lane, model, variant, name, by, detail}`.
Events: `posted`, `review_posted`, `assigned`, `dispatched`, `delivered`, `failed`, `bounced`, `stalled`,
`cancelled`, `owner_ruling`, `delivery_write_failed`, `status_<status>`.

## Safety

The server binds to 127.0.0.1. Writes must be same-origin JSON addressed to a local host name, because any
web page you visit could otherwise make your browser dispatch paid workers. Review pages are served with a
CSP that only allows saving annotations. Brief paths are restricted to the configured folders because a
brief's contents are sent to third-party models.

## Board app and desktop app

The board page is a React app in `web/` (Vite, React Flow + dagre for the relationship graph). The board
server serves its build (`web/dist`) at `/`; without a build it serves the classic page, which also stays
available at `/classic`.

```text
cd web && npm install && npm run build      # build the app the server serves
cd web && npm run dev                       # develop against a running board server (proxy to :6097)
```

`desktop/` is a Tauri 2 shell. Double-click it and it finds your project, starts that project's board
server if it is not already running, and shows the board in a native window; it stops only the server it
started. It needs Node 22 on the machine. The first launch asks for the project folder (the one with
`questboard.config.json`) and remembers it.

```text
cd desktop && npm install
npm run dev          # run from this checkout
npm run build        # Windows installer; builds web/ first and bundles the server
```

The window loads the server's own page, so the board keeps the server's same-origin write rules and the
page gets no desktop permissions.

## Tests

```text
npm test
```

## License

MIT
