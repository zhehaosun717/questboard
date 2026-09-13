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

Status: used daily on one real project. Core, HTTP server, CLI, MCP server, the React board (quest wall,
relationship graph, message board, review pages, dispatch history, roster and model config, provider usage,
settings) and the Tauri desktop shell all work and are tested.

## Requirements

- Node 22 or newer. No runtime dependencies for the board itself.
- On Windows, Git Bash for `.sh` lane scripts (plain `bash` there is often WSL). Set `"bash"` in the
  project config or `QUESTBOARD_BASH` if it is not in a standard location.

## Quickstart

```bash
git clone https://github.com/zhehaosun717/questboard && cd questboard && npm install -g . && npm run setup
```

`npm install -g .` gives you the `questboard` command; `npm run setup` builds the board UI (`web/dist`), and
without it the server falls back to the classic single-file page. Then set up a project — this writes the
config, the worker wrapper, a sample brief and the machine roster in one go, with lanes matching the agent
CLIs it finds installed:

```bash
questboard init ~/my-game
```

Add your first card (one model you can actually run), then start the board:

```bash
questboard card add --id my-codex --name Codex --provider OpenAI --lane codex --model gpt-5.6-luna --variant high
```

```bash
questboard serve --project ~/my-game
```

Open `http://127.0.0.1:6097/`, post the sample quest, and drag the card onto it:

```bash
questboard post --package RUN-1 --brief docs/briefs/RUN-1-first-task.md --project ~/my-game
```

`questboard doctor --project ~/my-game` is the thing to run when something looks wrong: it checks Node,
paths, lane scripts, Git Bash, lane APIs, the roster, key sources (presence only) and whether a board is
already on the port.

**Your own tools.** A lane is just a command, so tell `init` about whatever you use — repeat `--lane` for
each one:

```bash
questboard init ~/my-game --lane aider="aider --model {model} --yes" --lane mytool="python tools/agent.py"
```

The brief is piped to that command's stdin and `{model} {variant} {name} {package}` are filled in. Without
`--lane`, `init` writes lanes for the CLIs it knows how to drive and finds installed (`codex exec -m
<model>`, `claude --print --model <model>`), and names any other CLI it found (OpenCode, agy, Gemini,
cursor-agent) so you can add it with `--lane`. Check your CLI's `--help` for how it takes a prompt: a tool
that wants the prompt as an argument, or needs a session first, needs a small script of your own in `run` —
see "Project config" below.

Prefer not to touch a terminal? `desktop/` builds a Windows installer that bundles the server, the UI and
this setup command, so the only requirement on the machine is Node 22. Pick a folder that is not a project
yet and the app offers to set it up for you, then opens the board — no commands at all.

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
questboard roster init [--force] | roster path | roster import <old roster.json>
questboard board post|reply|list|read|close|inbox
questboard watch [--from-start]
questboard doctor                            # read-only setup check: paths, scripts, Git Bash, roster, key sources, the server
```

`examples/basic/` is a complete starting point: copy it, and its `scripts/run-worker.mjs` wraps any agent
CLI so the board can see the worker (registry row, `.out` / `.exit` / `.md` files). See its README.

## MCP

`questboard mcp` is an MCP server over stdio, so any agent can use the board as tools instead of shell
commands: `questboard_list_quests`, `questboard_get_quest` (with who may take it and why not),
`questboard_post_quest`, `questboard_set_quest_status`, `questboard_record_ruling`, `questboard_assign`,
`questboard_adopt`, `questboard_release_worker` (free a stalled quest once you confirmed its process is
gone), `questboard_list_cards`, `questboard_set_card_status`, `questboard_events`, `questboard_board_post`,
`questboard_board_reply`, `questboard_board_inbox`. Writes go through the running board server; start it
with `questboard serve` first.

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
`released`, `cancelled`, `owner_ruling`, `delivery_write_failed`, `status_<status>`.

A `stalled` quest keeps its worker: silence is not a confirmed exit, so its parallel slot and file
reservations stay held and nobody can be dispatched onto it. When output resumes it goes back to
`dispatched`; when an exit file appears it finishes normally. Once someone has confirmed the process is
gone, `POST /api/quests/<id>/release` (or the `questboard_release_worker` MCP tool, or the drawer button)
frees it with a `released` event.

Every event carries a `seq`. `GET /api/events?after=<seq>&limit=<n>` (or the MCP tool with `after`) returns
the next events oldest first, so a reader that stores the last `seq` it handled never misses one — unlike
polling by time, which can skip two events written in the same second. Lines written by an older board
without `seq` are numbered by position.

Every quest carries a `revision`, bumped on each change. `assign` and `adopt` accept `ifRevision`: if the
quest changed since you read that revision, the call is refused with `stale_revision` instead of dispatching
onto a quest you have not seen. They also accept a `requestKey` of your choosing: a retry with the same key is
answered with the existing attempt (`repeated: true`), never a second worker.

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
npm run setup                               # from the repo root: install and build the app the server serves
cd web && npm run dev                       # develop against a running board server (proxy to :6097)
```

`web/dist` is a build artifact and is not committed, so a fresh clone serves the classic page until you run
`npm run setup`.

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
