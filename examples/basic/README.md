# Basic Project Example

This directory provides a minimal, working project template for `questboard`.

## Files in this example

Most people should not copy this by hand — `questboard init <dir>` writes the same thing, with lanes matching
the agent CLIs actually installed on the machine. This folder is the reference for what it produces.

- `questboard.config.json`: The project configuration file. It defines the project name, port, data directories, brief discovery paths, policy rules, and three lanes (`codex`, `claude`, `claude-review`).
- `scripts/run-worker.mjs`: A generic, cross-platform Node.js worker wrapper. It records dispatches to the registry, initializes output files, streams stdout/stderr, feeds the brief (and an optional `--role` card) on stdin, and records exit codes. Before any of that it takes an exclusive lock on the worker name and retires that name's previous terminal artifacts into an archive folder, so a repeated name is never mistaken for the run in progress. It also answers a cooperative cancellation request over IPC — see "Role cards and cooperative cancellation" below.
**Lanes for other CLIs.** The lanes here are for agent CLIs that read their instructions from stdin, which is
what the wrapper pipes (`codex exec -m <model>` with no prompt argument, `claude --print --model <model>`).
A CLI that takes the prompt as an argument (OpenCode's `opencode run "<message>"`, Google's agy `--print=`)
needs a lane you write yourself: either a small script of your own in `run`, or a server lane with `api`,
`session` and `deliveryDir` — see "Project config" in the main README.

## Trying the board in five commands

1. Copy the example into your project root:
   ```bash
   cp -r examples/basic/* /path/to/your-project/
   ```

2. Check the setup, then start the questboard server:
   ```bash
   questboard doctor --project /path/to/your-project   # paths, scripts, roster, key sources — read-only
   questboard serve --project /path/to/your-project
   ```

3. Post a quest with a brief:
   ```bash
   questboard post --package RUN-1 --brief docs/briefs/RUN-1.md --title "First task"
   ```

4. Assign the quest to an adventurer card (via CLI or drag-and-drop in the web UI at `http://127.0.0.1:6097`):
   ```bash
   questboard assign RUN-1 --adventurer codex-luna --request-key run1-first-try
   ```

5. Inspect status and watch updates:
   ```bash
   questboard list
   ```

## What the wrapper writes and where

When a worker is dispatched, `scripts/run-worker.mjs`:

0. **Lock**: Before touching any shared artifact, creates `.questboard-data/workers/<lane>/<name>.lock` exclusively, with a random token written into it that identifies this run. If a run with this name is already using it, the wrapper fails immediately with a one-line error instead of writing a second registry row or interleaving output with the run in progress; it never inspects or kills whatever holds an existing lock. A lock left behind by a **force-killed** wrapper (`SIGKILL`, a crashed machine) does not come off by itself -- Node's normal exit handling never runs -- and has to be removed by hand, but only once you have actually confirmed that old process is stopped, not just that it looks stuck. Removing the lock of a run that is still alive does not stop that run; it only lets a second attempt start under the same name while the first is still going. If that happens anyway, the wrapper's per-run token limits the damage: a run whose lock was pulled out from under it can tell, right up to its own last write, that it no longer owns the name, and neither deletes the new run's lock nor publishes its own (now-stale) result over the new run's live `.exit`/`.md` -- it parks that result under `.archive/<name>.exit.orphaned.<stamp>` (and `.md.orphaned.<stamp>` if it had a report) instead. This is a check-immediately-before-writing guard, not a transactional lock: nothing here can promise safety against something rewriting the lock file in the instant between that check and the write. A normal finish (the worker completes and this run still owns the lock) removes the lock as its very last step, after every other artifact is published; a force-killed wrapper is the only case that leaves one behind.
1. **Stale artifact retirement**: Any `<name>.out`, `<name>.exit`, or `<name>.md` left over from an earlier run with the same name is moved into `.questboard-data/workers/<lane>/.archive/` (timestamped, not deleted) before this run starts. This keeps a repeated name from ever showing a previous run's report or exit code as if it were current, while still leaving that earlier evidence on disk to recover.
2. **Registry row**: Appends a `dispatch` event to `.questboard-data/registry.jsonl`:
   ```json
   {"at": "2026-09-13T12:00:00.000Z", "event": "dispatch", "package": "RUN-1", "lane": "codex", "model": "...", "variant": "...", "name": "run1", "brief": "..."}
   ```
3. **Output stream**: Creates `.questboard-data/workers/<lane>/<name>.out` empty immediately so the board's `workerEvidence` sees active progress, then streams both standard output and standard error into it.
4. **Exit code**: Waits for the worker process to complete and writes its integer exit code to `.questboard-data/workers/<lane>/<name>.exit`, last, once every other artifact for this run is in place. If this run's cancellation was requested and acknowledged (see "Role cards and cooperative cancellation" below), a second line is appended: `{"requestId": "...", "scope": "direct-child"}`, so the board can tell a cooperative stop apart from an ordinary exit.
5. **Report (optional)**: If the lane passes `--report <path>` and that file looks like it was actually produced or refreshed by *this* run's worker (its size or modified time changed from what it was right before the worker started), it is staged to a temp file and, once this run confirms it still owns the lock (the same check that guards `.exit`, see item 0), moved onto `.questboard-data/workers/<lane>/<name>.md` before `.exit` is written. A `--report` file that already existed, unchanged, before this run started -- typically because a lane reuses the same report path across runs and this run's worker never wrote to it -- is treated the same as no report at all, so a previous run's report is never republished as if it were this run's own. The source file itself is only ever read, never modified or deleted -- **except when `--report` is set to this run's own live `<name>.md` path.** That is unusual (most lanes write their report somewhere else and let the wrapper copy it), but if it happens, that path is this worker name's own previous terminal artifact, so item 1 above retires it into `.archive` before this run starts, same as `<name>.out`/`<name>.exit`. If this run's own child does not go on to recreate that exact path, there is nothing fresh to publish and no report appears live after this run either; the previous content is not lost, only moved to `.archive/<name>.md.<stamp>`, recoverable there. Point `--report` at a path other than the live `<name>.md` if you want the wrapper to leave that file alone entirely.

The wrapper itself normally exits with code `0` once the worker has launched and its terminal artifacts are written (even if the worker itself exited non-zero). It can also exit non-zero in several situations, each distinguishable from the others by what has already been written when it happens:

- **Pre-registration refusal** (missing brief, invalid config or lane; a name still locked by a run in progress; the lock file itself could not be created or written; or retiring a previous run's stale `.out`/`.exit`/`.md` into `.archive` failed): fails before the registry row is ever written. No `.exit` file appears for this attempt, and no `.out` either.
- **Registry-write failure** (the `dispatch` row could not be appended to `.questboard-data/registry.jsonl`, for example a missing or read-only data directory): the same evidence as a pre-registration refusal above -- no registry row, no `.out`, no `.exit` -- called out separately here because it is a distinct point of failure, not because a reader can tell it apart from the cases above.
- **Output-initialization failure** (`<name>.out` could not be created or opened, immediately after the registry row above it was already written): the registry row exists, but `.out` may be missing or unusable and no `.exit` is written for this attempt either.
- **Spawn or start failure** (the agent command could not be found or started, or one of its arguments could not be safely passed through a Windows `.cmd`/`.bat` shim; see "A note on Windows `.cmd`/`.bat` arguments" below): happens *after* the registry row and a working `.out` already exist, so both of those are present. `.exit` is written 127 for command-not-found, or 1 for any other start failure or an unsafe argument, with a one-line explanation in `.out`.
- **Report-publication failure**: this covers two distinct points where a `--report` file that exists and looked fresh still could not reach the board. If it could not even be copied into a temp file (for example the report path itself is a directory), `.exit` is forced to a non-zero code and no `<name>.md` appears at all. If the temp copy succeeded but the later move onto the live `<name>.md` failed (for example something now occupies that exact path), `.exit` is still forced to a non-zero code the same way, but the staged report bytes are kept -- either published to `.archive` as orphaned evidence or, if even that could not be written, left at their original temp path -- rather than lost; either way `.exit` never comes up missing just because the report side of a run failed.
- **Exit-publication failure** (`.exit` itself could not be written, for example the output directory became unwritable partway through the run): the rarest case -- the worker's own outcome is known internally but no `.exit` file is produced for this attempt, and the lock is released same as any other failure. This can happen after a report was already published live, so a live `<name>.md` can exist for a run that has no `<name>.exit` at all -- distinct from a report-publication failure, which always forces a non-zero `.exit` rather than omitting it.

In every one of these non-pre-registration cases the wrapper's own process exit code is non-zero even though `.exit` may already hold a different number -- the board reads `.exit`, not the wrapper's own exit code, as the terminal marker; the wrapper's own exit code only matters to whatever launched it directly.

### A note on Windows `.cmd`/`.bat` arguments

When an agent command resolves to a `.cmd`/`.bat` shim (the normal case for npm-installed CLIs on Windows), each argument is quoted so that whitespace and the characters `& | < > ^ ! ( )` are passed through literally instead of being read as cmd.exe operators (delayed expansion is also disabled for this call with `/v:off`, so `!` is always literal, not just when the machine's default happens to have it off). Three kinds of value cannot be made safe this way, and the wrapper refuses to spawn (a start failure, exit 1, per above) rather than attempt ad hoc escaping if any argument contains one:
- **`%`** -- cmd.exe expands `%name%` references while parsing its command line even when they sit inside a quoted argument, so no quoting scheme here can guarantee a `%`-bearing value reaches the worker unchanged.
- **A double quote (`"`)** -- a backslash does not escape a quote for cmd.exe's own parser (only for the child's later argv parsing), so a `"` inside an argument flips cmd.exe's quote state and un-quotes everything up to the next `"`, including metacharacters riding along in the same or a later argument.
- **A control character, CR/LF included** -- cmd.exe treats these as command separators while parsing the `/c` string, silently truncating the argument instead of passing it through.

This limitation is specific to the `.cmd`/`.bat` shim path; a real executable (`node.exe`, `codex.exe`, ...) receives its arguments directly from Node with no shell involved, so exact quotes, newlines and control characters all pass through unchanged there. If a lane's arguments need any of the above, prefer a lane whose command is a real executable (or a small wrapper script of your own, invoked directly) over one that resolves to a `.cmd`/`.bat` shim.

## Role cards and cooperative cancellation

The wrapper accepts an optional `--role <path>` flag (a file relative to the project root). When set, its
contents are read and prepended to the brief on the worker's stdin, separated by a blank line — the role
card, then the brief. A lane opts into this by adding a `--role {role}` argument pair to its `run` array
(see "Lane and policy options" in the main README) — `roleInPrompt: true` documents the intent but is not
itself required, since `{role}` appearing in `run` is what triggers it; `{role}` is refused in
`session.saveTo` and `env`, since neither is a safe place for it.

The board's dispatcher also passes `QUESTBOARD_ATTEMPT_ID` and `QUESTBOARD_CONTROL_TOKEN` in the worker's
environment on a lane whose `control.type` is `generic-wrapper`. The wrapper uses them to authenticate a
single IPC message from its parent, `{type: 'questboard-cancel', attemptId, token, requestId}`: only a
message whose `attemptId`/`token` match, and whose `requestId` looks like an id, is accepted, and only once
per run. On acceptance it acknowledges with `{type: 'questboard-cancel-ack', attemptId, requestId, scope:
'direct-child'}` and kills the direct child process handle it created (nothing further upstream or
downstream of that child). Both environment variables are stripped from the child's own environment before
it starts, and an acknowledged cancellation is recorded as the second line of `<name>.exit` (see
step 4 above), so a lane without `control.type: generic-wrapper` configured simply never receives these
variables and cannot be cancelled this way — `questboard_cancel_worker` reports `manual_required` for it.

## Swapping in a real agent command

In `questboard.config.json`, the command arguments after `--` in each lane's `"run"` array are passed directly to your agent CLI:

```json
"run": [
  "node", "scripts/run-worker.mjs",
  "--lane", "codex",
  "--name", "{name}",
  "--brief", "{brief}",
  "--model", "{model}",
  "--variant", "{variant}",
  "--package", "{package}",
  "--",
  "codex", "exec", "-m", "{model}", "-"
]
```

Replace the command after `--` with your preferred tool:
- **Codex CLI**: `codex exec -m {model}` — with no prompt argument it reads the brief from stdin
- **Claude Code**: `claude --print --model {model}` — the prompt comes from stdin
- **Custom scripts or binaries**: `python scripts/my-agent.py --model {model}`

Check your CLI's `--help` for how it takes a prompt before trusting a lane you wrote.

The brief is always piped to the command's stdin; it never appears on the command line. On Windows a bare
command name is looked up on `PATH`, and npm's `.cmd` shims (`codex`, `claude`, `opencode`) are started
through `cmd.exe` with each argument quoted; real executables are started directly.
