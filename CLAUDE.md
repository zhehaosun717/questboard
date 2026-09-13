# questboard — Agent Instructions

Read this before working on the repo. If `CLAUDE.local.md` exists, read it too (machine-specific notes).

## What this is

A local, single-user **quest board for dispatching AI coding agents**. Quests are written briefs; cards are
models reachable through lanes (CLIs or servers). The owner drags a card onto a quest; the board checks the
rules, shows any refusal *before* the drop, and runs the lane's command headless. A coordinator agent posts
quests, adopts workers it started by hand, and tails the events file.

It must stay **reusable across projects**: nothing project-specific in `src/`.

## Layout

| Path | What |
|:---|:---|
| `src/core/` | Pure-ish domain: config, roster, status log, rules, quest store, briefs, overlay, sync, dispatch, deliveries, snapshot |
| `src/lanes/` | Collector: reads the project registry and each worker's state (file lanes, server lanes, verification) |
| `src/server/` | HTTP: pages, quest API, dispatcher, message board, annotations |
| `src/cli/` | `questboard` CLI |
| `public/` | Board UI (to be replaced by the Tauri app) |
| `examples/` | Project configs |
| `test/` | `node --test` suites mirroring `src/` |

## Data layers — keep them separate

1. Machine roster `~/.questboard/roster.json`: facts about models. **No status, no dated notes** — the
   validator rejects a `status` field.
2. Status log `~/.questboard/status.jsonl`: `{at, adventurerId, status, reason, setBy}`.
3. Project config `questboard.config.json`: briefs, lanes, paths, policy.

## Contracts

- Events file: one JSON line per change, `{at, event, package, lane, model, variant, name, by, detail}`.
  Events: posted, review_posted, assigned, dispatched, delivered, failed, bounced, stalled, cancelled,
  owner_ruling, delivery_write_failed, status_<status>. Coordinators depend on these names.
- Registry file: written by the project's own dispatch scripts, one `event: "dispatch"` line per worker.
- Lock file present → no dispatch.
- Lane templates fill `{name} {brief} {model} {variant} {agent} {package}`; a missing value is an error.
- Writes must be same-origin JSON on a local host name.

## Traps already hit

- Never open a child process's log with Node `'a'` on Windows: Git Bash cannot write to the append-only
  handle, the wrapper's final `echo` fails under `set -e` and the dispatch reports exit 1 while its worker
  runs. Use `'w'`, and treat a non-zero wrapper exit as started when the registry row or `.out` appears.
- Plain `bash` on Windows may be WSL; use Git Bash.
- A parent folder's `package.json` with a different `"type"` silently changes how files load. This repo is
  ESM and declares it.
- Adopted workers: their registry row predates the adoption; match them by worker name.
- Timers started at module load keep test processes alive forever; start background work explicitly.
- Some shells do not expand `test/**`; `npm test` passes the glob to Node.

## Working rules

- Run `npm test` before and after changes; add a test with every behaviour change.
- Files 200–400 lines, 800 max. Immutable updates. Validate at boundaries. Missing data fails loudly and
  names what is missing — never invent a fallback value.
- UI text is Chinese with plain, everyday wording; refusals must say why.

## Plan

1. ~~Core, server and CLI in this repo~~ (done: 67 tests).
2. ~~MCP server over the core~~ (done: `questboard mcp`, 13 tools, 74 tests).
3. Tauri desktop app (Vite + React + React Flow + dagre) in the same salvage-guild style.
4. Integrated tabs: message board, review pages, model config, history, settings, usage panel.
5. Parallel run, data migration, switch the first-generation board off.
