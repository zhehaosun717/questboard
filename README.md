# questboard

A local quest board for dispatching AI coding agents across CLIs and providers.

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

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
| `~/.questboard/roster.json` (or `QUESTBOARD_HOME`) | Cards: id, name, provider, lane, model, family, variant, variants, agent, billing, parallel limit, strengths, generic notes, `env` | every project on the machine |
| `~/.questboard/status.jsonl` | Status records: `{at, adventurerId, status, reason, setBy}`. A card without records is available | every project |
| `<project>/questboard.config.json` | Brief folders and id pattern, lane commands, output folders, events/registry/lock paths, banned models | one project |

Dated decisions ("paused on 9/12 because it costs too much") are status records, never roster text, so the
roster stays reusable.

A card's `env` is for provider settings only, and only non-secret values. A name is accepted only if it
ends with `_BASE_URL`, `_API_BASE`, `_API_URL`, `_MODEL`, `_MODEL_NAME`, `_MODEL_ID`, `_REGION`,
`_ACCOUNT_ID`, `_PROJECT_ID`, `_ORG_ID`, `_ORGANIZATION`, `_TIMEOUT_MS`, `_MAX_TOKENS`, `_TEMPERATURE`,
`_EFFORT`, `_VARIANT`, `_PROVIDER`, `_DEPLOYMENT` or `_API_VERSION`; is one of `MAX_TOKENS`, `MODEL_NAME`,
`MODEL`, `PROVIDER_REGION`, `API_TIMEOUT_MS`; or is listed in the project's `policy.cardEnvAllow` (exact
UPPER_SNAKE_CASE names). Every other name is refused. A base URL does more than receive the key the lane
inherits from the machine environment: a model base URL decides who answers the model, and therefore
decides what the worker acts on. Some non-model URLs also fit the allowed shape (for example
`GITHUB_API_URL`, which receives `GITHUB_TOKEN`-style keys), and the browser-download mirror families
(`PUPPETEER_`, `PLAYWRIGHT_`, `CYPRESS_`, `ELECTRON_`) are denied by prefix because they make a worker
download and run a binary from that host. Card `env` is trusted configuration: only put hosts you trust
there, and review every value before saving. **Names you add to `policy.cardEnvAllow` widen that trust
deliberately and are your responsibility**: the board cannot tell what a program does with them. Even an
allowed name is still
refused if it is shaped like a loader, search path, config/home directory, or build-tool switch (including
`*_HOME`/`*_CONFIG_DIR`), because it would change where the lane reads config or loads code from. A card
saved before a rule existed still loads, with a note, but cannot be dispatched until its `env` is fixed.

## Project config

See [`examples/basic/questboard.config.json`](examples/basic/questboard.config.json). A lane is a
command template plus where its workers can be observed:

```json
"codex": {
  "run": ["tools/codex-run.sh", "{name}", "{brief}", "{model}", "{variant}"],
  "outputDir": ".claude/codex"
}
```

Placeholders: `{name}` (unique worker name), `{brief}`, `{model}`, `{variant}`, `{agent}`, `{package}`,
`{role}` (an optional per-attempt role card, see the table below). A placeholder without a value is an
error, never an empty string. `.sh` commands run under Git Bash, `node` under the current Node. File lanes
write `<outputDir>/<name>.out` while running, `<name>.exit` when done, and optionally `<name>.md` as the
report. Server lanes (OpenCode) set `api`, a `session` step and a `deliveryDir`; their final message is
written to `<deliveryDir>/<name>.md` before `delivered` is announced. `serialize` runs one dispatch at a
time; `spacingMs` spaces starts; `defaultModel` labels old registry rows.

The project's own scripts register each dispatch in the registry file (one JSON line with `event:
"dispatch"`, `package`, `lane`, `model`, `name`, and `session` for server lanes). That registry is how the
board sees workers — including ones started by hand.

### Lane and policy options

Every field below is optional; a config that never mentions one keeps the behaviour from before it existed.

| Field | What it does |
|:---|:---|
| `lanes.<id>.roleInPrompt` (bool) | This lane accepts a `{role}` role card in its prompt (see `--role` in `examples/basic/README.md`) |
| `lanes.<id>.limits.maxMessages`, `.maxMinutes` | `maxMessages` caps a session-lane attempt's message count; `maxMinutes` caps wall-clock runtime on any lane. Going over a limit marks the attempt `stalled` with a reason — a `generic-wrapper` lane is cancelled automatically, other lanes need manual handling |
| `lanes.<id>.control.type` (only `"generic-wrapper"`) | This lane's script speaks the wrapper's cancel IPC (`QUESTBOARD_ATTEMPT_ID`/`QUESTBOARD_CONTROL_TOKEN`), so `questboard_cancel_worker` can ask it to stop |
| `lanes.<id>.protocol` (only `"opencode-session"`, needs `api`) | Which server contract `api` speaks; defaults to `opencode-session` when `api` is set, so no existing config has to name it |
| `lanes.<id>.optionalArgs[{when,args,omitWhen,insertAt}]` | Inserts extra argv only when `when` (`variant` or `agent`) is actually supplied, unless its value is in `omitWhen`; `insertAt` picks the position, defaulting to the end of `run` |
| `policy` (object) | The policy block must be an object: omit it entirely to get the defaults, but `"policy": null` (or a string or an array) is refused rather than silently falling back |
| `policy.stallAfterMinutes` (default 20) | How long a lane goes quiet before the board calls it `stalled` |
| `policy.laneConcurrency.<lane>` | A per-lane cap on attempts running at once, on top of each card's own `maxParallel` |
| `policy.defaultLane`, `policy.defaultCard` | Neither pre-selects anything on the board. `defaultCard` is read only by the CLI's `questboard assign` when no card is named; `defaultLane` is only validated, shown in preferences, and edited on the settings page |
| `policy.cardEnvAllow[]` | Extra exact `env` names a card may carry on top of the built-in allowed shapes; the deny list still wins over names listed here |
| `policy.bouncePatterns[{code,pattern,label}]` | Regexes matched against an exit line that turn a failure into a labelled `bounced` status |
| `policy.reviewRequires[report\|project-verification\|hook]` | Which upstream evidence kinds a review must show before it may be dispatched (warns only when empty, the default) |
| `usage.manualProviders[]` | Turns on usage cards for providers with no confirmed public usage API (Alibaba token/coding plan, NVIDIA, OpenAI spend) — each shows a "check the console" note instead of a fetched number (see the 用量 settings tab). `claude-subscription` is still accepted here, but the Claude card is always shown regardless — it can show live status-line numbers, so listing it does nothing |
| `usage.experimentalProviders[]` (currently only `codex-app-server`) | Opt-in list: an experimental usage source is only read when named here, otherwise it stays off |
| `usage.alibaba.{edition,region}` | Edition/region for the Alibaba usage source |
| `reviewPages.dir` (and optional `filePattern`) | Folder of standalone review HTML pages the board serves and lets an art review annotate |

The `{role}` placeholder itself, and `lanes.<id>.session.saveTo`/`lanes.<id>.env` refusing it, are covered in
[CLAUDE.md](CLAUDE.md)'s Contracts section.

## CLI

```text
questboard serve [--project <dir>] [--port <n>]
questboard post --package RUN-4 --brief docs/briefs/RUN-4-x.md [--kind code|review|art|tool|owner]
     [--parents A-1] [--conflicts B-2] [--lanes codex,agy] [--priority 1|2|3] [--needs-owner "question"]
questboard list | status <id> <status> | ruling <id> --text ... | assign <id> --adventurer <card>
questboard adopt <id> --adventurer <card> --name <worker>
questboard update <id> [--title ...] [--brief ...] [--parents ...] [--conflicts ...] [--lanes ...]
     [--needs-owner "question"] [--if-revision <n>]   # correct a posted quest's own fields; refused while a worker holds its slot
     # a posted review's own parent/kind, and every ancestor it reaches (and that ancestor's kind), are fixed
     # permanently, even once the review is cancelled — post a new, correctly linked quest instead
questboard card list | card status <card> <available|limited|broke|paused|disabled> --reason "..."
questboard roster init [--force] | roster path | roster import <old roster.json> [--dry-run | --force | --replace --force]
questboard board post|reply|list|read|close|inbox
questboard watch [--from-start]
questboard doctor                            # read-only setup check: paths, scripts, Git Bash, roster, key sources, the server
```

`roster import` merges by card id: locally customized per-card `env`, variants and cards the file does not
mention survive (only explicitly supplied values are overlaid, `env` key by key), everything is validated
before a byte is written, and the previous roster is backed up first, to a collision-proof
`roster.json.bak-<time>-<n>-merge` (a counter breaks a tie if two imports land in the same second, so both
snapshots survive). `--dry-run` prints the plan (counts and changed field names only, never values, never
env keys or note text). Status is one-way: **an import only ever adds a card's first-ever status record.**
Once a card has any status history at all — including an explicit `available` — the import leaves it alone,
however new the imported record or the file's own modification time; there is no flag to force an override,
by design. A first-time status coming from a legacy file with no per-card dated field is still imported (so
the card is not silently left "available" for no reason), but its record says plainly that the date is the
import's own guess, not a real owner decision. `--replace --force` is the separate, explicit full
replacement (it backs up too); plain `--force` only confirms the merge and never erases. Anything the import
can't parse is refused by shape and position, never by quoting file content back at you.

`examples/basic/` is a complete starting point: copy it, and its `scripts/run-worker.mjs` wraps any agent
CLI so the board can see the worker (registry row, `.out` / `.exit` / `.md` files). See its README.

## MCP

`questboard mcp` is an MCP server over stdio, so any agent can use the board as tools instead of shell
commands. 17 tools: `questboard_list_quests`, `questboard_get_quest` (with who may take it and why not),
`questboard_post_quest`, `questboard_set_quest_status`, `questboard_record_ruling`, `questboard_assign`,
`questboard_adopt`, `questboard_release_worker` (free a stalled quest once you confirmed its process is
gone), `questboard_cancel_worker` (ask the current attempt to stop cooperatively; durable until matching
evidence arrives, or `manual_required` on a lane that cannot cancel itself), `questboard_resolve_worker`
(free a held worker after an explicit acknowledgement and a reason, recorded as `manual_resolution`),
`questboard_update_metadata` (revision-guarded correction of title/brief/parents/conflicts/
allowedLanes/needsOwner on a quest that does not hold a worker's slot; any other field is refused, and a
posted review's own parent/kind, plus every ancestor it reaches and that ancestor's kind, are permanently
fixed), `questboard_list_cards`,
`questboard_set_card_status`, `questboard_events`, `questboard_board_post`,
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

`<events file>` gets one line per change: `{seq, at, event, package, lane, model, variant, name, attemptId,
by, detail}`. Events: `posted`, `review_posted`, `assigned`, `dispatched`, `delivered`, `failed`, `bounced`,
`stalled`, `released`, `cancelled`, `owner_ruling`, `delivery_write_failed`, `status_note`,
`manual_resolution`, `cancel_requested`, `cancel_acknowledged`, `cancel_result`, `review_override`, `metadata_update`,
`status_<status>` (any other quest status).

`status_note` carries a text update without moving the quest to a new terminal or status event; `manual_resolution`,
`cancel_requested` and `cancel_acknowledged` are the cancel/manual-release path (see `questboard_cancel_worker`
and `questboard_resolve_worker` below); `review_override` records an owner override of a review lock;
`metadata_update` additionally carries `changedFields` (names only) and `changes` (`{field: {from, to}}`,
non-secret values only). A terminal event additionally carries `report` when the attempt captured one, and
an art `dispatched` event additionally carries `annotationCount`/`annotationPage`.

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

A lane's quota-limit evidence (`snapshot.laneLimits`/`snapshot.laneEvidence`) is tracked per card. Once a
card is no longer effectively limited, its entry moves from `laneLimits` into
`laneEvidence[lane].cards[<id>].cleared`, worded neutrally rather than claiming an action happened:
`owner` (a status-log record for that card postdates the evidence — an acknowledgement), `success` (a later
successful run by that same card), `expired` (the entry's own known reset time has passed with no newer
acknowledgement), `status` (the card is paused, disabled or broke for its own manual reason), or `no_card`
(the id is no longer in the roster). A card the owner has limited again keeps its `laneLimits` entry instead
(it is truthfully limited) but never keeps a stale `until`/`resetsAt` from evidence that predates that
manual action. The `cleared` field name and its readers never change — a reader that does not recognize a
value can keep treating it as "no longer limited, reason unspecified". `GET /api/lanes` only carries the
same stale-`until`/`resetsAt` drop on `laneLimits`; it does not return the per-card `cleared` evidence
itself.

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
