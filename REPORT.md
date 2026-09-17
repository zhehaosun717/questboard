# Bundle F delivery report — brief and annotation containment, reviewer brief, bulk wording

Worktree `E:/questboard/.claude/worktrees/qb-fb-bundle-f`, branch `cx/bundle-f`, base `068a322` (current MAIN
at brief time). No commits made — this report is the handoff; the PM/coordinator commits.

## F1 — `prepareAnnotationSnapshot` refuses a containment escape before assign, without creating anything

**File:** `src/core/annotationSnapshot.js`.

Added `snapshotTargetContainmentIssue(config)`, called first thing inside `prepareAnnotationSnapshot`:
- Checks `config.paths.data` for containment against `config.root` (catches a `dataDir` that escapes the
  project, whether or not the folder exists yet) — Chinese reason `派遣数据目录不能用：<cause>`.
- Only if the data folder already exists, checks a `dispatch-briefs` subfolder for containment against the
  data folder (catches a junction/symlink resolving outside it) — Chinese reason `批注快照目录不能用：<cause>`.
- Neither half calls `mkdirSync` or touches the filesystem beyond `existsSync`/`realpathSync` (via the existing
  `realpathContainmentIssue`), so a data folder or `dispatch-briefs` folder that simply has not been created
  yet is correctly treated as "nothing to check", not an escape.

On a hit, `prepareAnnotationSnapshot` throws `AnnotationSnapshotError` with code `snapshot_containment` —
`dispatcher.js`'s existing call site already turns any throw from `prepareAnnotationSnapshot` into a 409
`refused` **before** `store.assign` runs (verified by reading `src/server/dispatcher.js:384-390`, unchanged),
so this is a genuine pre-assign refusal: no attempt is minted, no failed dispatch row is left behind.

**Tests added** (`test/core/annotationSnapshot.test.js`, real Windows junction, not mocked):
- `refuses a data directory outside the project before assign, creating nothing (F1)`
- `refuses a dispatch-briefs junction resolving outside data before assign, creating nothing when supported
  (F1)` — creates a real junction with `fs.symlinkSync(outside, dispatchBriefs, 'junction')`, skips cleanly
  with a stated reason (`EPERM`/`EACCES`/`UNKNOWN`) if the sandbox can't create one.
- `does not mistake a data folder that has simply never been created for an escape (F2)`

## F2 — missing-data-folder wording, `validateAnnotationSnapshot` Chinese, dead branch

**File:** `src/core/annotationSnapshot.js`.

- **Missing data folder:** confirmed by direct reproduction (before touching code) that the reachable path
  (`writeAnnotationSnapshot` → `safeAttemptTarget`) already creates `config.paths.data` before any check that
  uses it as a realpath root, so it never actually emits `项目根目录不可读` for a merely-absent data folder.
  My new F1 check (above) preserves this: a missing data folder returns `null` (no issue) rather than probing
  `realpathContainmentIssue` with it as the root. Locked in by the third new test listed under F1.
- **Unreachable branch removed:** `writeAnnotationSnapshot`'s final `if (relative === '..' || ...) fail(...)`
  (around the old line ~235, now ~255) was dead — `safeAttemptTarget` already asserts containment of both the
  directory and the file, before and after `mkdir`, against both the data folder and the project root, so
  `target.file` can never fail this check. Removed, with a comment explaining why, in place of the check.
- **`validateAnnotationSnapshot` messages in Chinese — DEFERRED, out of file ownership.** This function lives
  in `src/core/store.js:100-115` (confirmed the only match for that name in `src/`), not in
  `annotationSnapshot.js`. The brief's file-ownership section explicitly excludes `store.js` by name. Its
  messages (`annotationSnapshot.page has an invalid page id`, etc.) are still English. Needs a follow-up in
  whichever slice owns `store.js`.

## F3 — a review brief says the file list is unknown and why, instead of an empty list

**File:** `src/core/reviewRequest.js`, function `buildReviewBrief`.

When `parent.briefUnknownReason` is set (the shape `withFileSets` — `src/core/briefs.js`, unchanged — already
attaches whenever a brief could not be read: too large, unreadable, containment-escaping, or missing), the
brief now writes `- 委托允许改的文件列表现在不知道：<reason>` instead of silently omitting the file-list bullet.
Falls back to the previous behaviour (list the files, or omit the bullet) when the reason is absent.

**Test added** (`test/core/reviewRequest.test.js`): `says the file list is unknown and why when the parent
brief is too large or unreadable, instead of an empty list`.

## F4 — briefs.js: per-folder read errors, stable 50k cap, dangling junctions, fail-closed held quest

**File:** `src/core/briefs.js`, function `scanDirectory` rewritten (the only user of the raw directory read).

- **Was:** `fs.opendirSync` + `handle.readSync()` in a loop, stopping at `MAX_DIR_ITERATE` (50000) raw entries
  in whatever order the filesystem returns them, sorting only the `.md` names collected before the cutoff. A
  `readSync()` failure mid-loop (e.g. `EIO`) was **not** caught — it threw straight out of `scanDirectory`,
  past `discoverBriefs`' per-folder try/catch (which only wrapped the initial `opendirSync` call), failing
  discovery for every configured folder, not just the one that hit the error.
- **Now:** a single `fs.readdirSync(directory, { withFileTypes: true })` call, wrapped in the same try/catch
  that already produced the per-folder Chinese diagnostic (`目录不可读（<code>）` / `目录不存在`). The full
  listing is sorted by name **before** the `MAX_DIR_ITERATE` cap is applied, so which entries survive the cap
  — and are therefore even candidates for the `.md`/`MAX_SCAN_ENTRIES` cap — is always the alphabetically-first
  slice of the directory, never an accident of raw filesystem order. This is a real behaviour change (the
  directory's full name list is now read in one call instead of streamed one Dirent at a time); the file's
  comment above `scanDirectory` was updated to say so honestly instead of claiming the old one-Dirent-at-a-time
  bound.
- **Dangling junction on the discovery/"post" path:** already refused before this change — `scanDirectory`
  classifies any symlink/junction entry (`entry.isSymbolicLink()`) as `skippedLinks` regardless of whether it
  resolves, and `discoverBriefs` reports it in `excluded` with Chinese reason `这是链接，跳过了，没有跟进去`,
  `kind: 'symlink'`; it never becomes a postable `items` row. Verified empirically before touching code, then
  locked in with a **real Windows junction** test (below) since the brief asked for proof, not just belief.
  **Caveat — a genuine remaining gap, out of file ownership:** this only covers the *discovery shelf* (the
  candidates offered for the owner to click "post"). A `POST /api/quests` request that names a dangling
  junction's path as `brief` directly (not discovered — typed or scripted) is **not** refused at POST time
  today: `validatePost` (`src/core/store.js`, excluded from this slice) only calls `briefPathAllowed`
  (`src/core/patterns.js`, also excluded), which checks the *directory*, not the individual file. The
  dangling brief only fails closed later, at dispatch, via the existing `briefUsable`/`fileStatusFor`
  (`briefs.js`, already correct and unchanged). Closing that POST-time gap needs a `briefUsable` call added to
  `validatePost` in `store.js` — flagging for whichever slice owns it.
- **Fail-closed behaviour for a held quest whose brief was deleted:** untouched (`fileStatusFor`'s
  `kind: 'missing'` path, `withFileSets`' conflict-key mechanism) — confirmed still green via
  `test/core/briefFailClosed.test.js` in the full suite run.

**Tests added/changed** (`test/core/briefDiscovery.test.js`):
- Rewrote the existing iteration-cap test's fake directory to mock `fs.readdirSync` instead of the
  now-unused `fs.opendirSync`/`handle.readSync` (same intent: truthful seen/returned counts, in microseconds
  instead of creating 50000+ real files).
- Added `which entries survive the raw-entry cap is a sorted, stable choice — never an accident of raw
  listing order (F4)`: 3 real `.md` briefs appended *last* in raw order, after 50002 filler entries that all
  sort after them; proves the two alphabetically-first briefs survive and a third one (sorting after all the
  filler) does not, and that the cap actually triggered.
- Added `a folder read failure is this folder's own diagnostic, not a crash that fails the whole snapshot
  (F4)`: mocks `fs.readdirSync` to throw `EIO` for one of two configured folders; asserts `discoverBriefs`
  does not throw, the failing folder gets its own diagnostic (`目录不可读（EIO）`), and the other folder's
  brief is still returned.
- Added `refuses a dangling junction sitting where a brief would be, with a Chinese reason, on the
  discovery/post path (F4)`: a **real** `mklink /J` junction (via `fs.symlinkSync(..., 'junction')`) whose
  target is never created, proving the refusal does not depend on the link resolving.

## F6 — rosterBulk.js wording and reason preservation

**File:** `src/core/rosterBulk.js`.

- **Wording:** both the bulk-preview `statusNote` and the per-card `quotaEvidenceProtection` refusal message
  changed from "请到那张卡上点「确认额度已恢复」" / "请使用单卡的"确认额度已恢复"操作后再试" (which names a
  button that `CardModal.tsx` does not render for manually limited/paused cards) to "请在单卡中确认额度已恢复
  （或手动改为可用）" / "...后再试" — names both real single-card paths instead of one that may not exist for
  the card being refused.
- **Reason preservation:** `statusChange` no longer blanks an existing status reason when a bulk `available`
  request finds a card already in that status and names no reason of its own (`patch.reason === ''`, the
  default when the bulk UI does not ask for one). In that specific case it now treats the request as a true
  no-op (same as the pre-existing "identical status and reason" no-op path already in the function) instead of
  writing a fresh record with `reason: ''`. A real status transition (e.g. paused → available), or an
  explicit reason supplied alongside the same status, is unaffected — verified by a dedicated new test.

**Tests changed/added** (`test/core/rosterBulk.test.js`):
- Added `a bulk available that finds a card already acknowledged keeps its existing reason instead of
  blanking it (F6)`.
- Added `a bulk status transition away from an acknowledged available card still clears the old reason
  normally` (guards against over-correcting into never writing a new reason).
- Updated the pre-existing `allows bulk available for a card whose single-card acknowledgement is newer than
  its quota evidence` test, which had been asserting the old bug as intended behaviour (`records[1].reason ===
  ''`, i.e. the acknowledgement text getting blanked) — now asserts the corrected no-op (`records.length ===
  1`, reason survives).
- Confirmed the existing wording assertions (`/确认额度已恢复/` in both `test/core/rosterBulk.test.js` and
  `test/server/rosterBulk.test.js`) still match the new message text unmodified.

## F5 — deferred, per the brief

`src/core/roster.js` variants trimming is explicitly out of this slice (belongs to the running security
slice) and was not touched.

## Deferred items summary (all due to file ownership, not missed on purpose)

| Item | What's needed | File (owner) |
|---|---|---|
| F2 (partial) | Translate `validateAnnotationSnapshot`'s English messages to Chinese | `src/core/store.js` |
| F4 (partial) | Call `briefUsable`/`fileStatusFor` from `validatePost` so a dangling junction named directly in a POST body is refused at POST time, not only at dispatch | `src/core/store.js` (via `src/core/patterns.js`'s `briefPathAllowed`, directory-only today) |
| F5 | Reject roster `variants` entries whose trimmed form differs | `src/core/roster.js` |

## Changed files (SHA-256, current worktree content)

```
3888d23ac5b9cb63fde23d66f6534741cee805a5b9b393640da7f147959ff51e  src/core/annotationSnapshot.js
ca545ae4164c6297d3c1f00a217e882b53ce01a48d0a6ffed4d42a3c08c0b718  src/core/briefs.js
794bee160f758f517bcd1e48373d928d2485b53c681eb91cfa12141c141c21a0  src/core/reviewRequest.js
7ac3834fc8ba8bebff1f108df959ab6aad1afe9226138cdca3e4b4c962adf0d8  src/core/rosterBulk.js
b6e798e4ba7a07665ef2e715655ae8952bf5b98149194469ecf5b702391015fc  test/core/annotationSnapshot.test.js
010cbddecc747e9774260c649d33c15d2f03ac64c2bea300b5d3a346c90602fc  test/core/briefDiscovery.test.js
5183edd86ce87ee739a9f16783e763a4a9c3eb4f86e6176ae70e7586cbed7095  test/core/reviewRequest.test.js
9a068e0c7cd97389b4c2f63db89463bf43bf252647cea10a1e4ab9adff233102  test/core/rosterBulk.test.js
```

`git status --porcelain` shows exactly these 8 paths modified, nothing else — no roster.js, store.js, or
questRoutes.js touched.

## Test counts

Per-file (isolated `node --test <file>` runs during development, all green):
- `test/core/annotationSnapshot.test.js`: **15/15** (was 12; +3 new)
- `test/core/reviewRequest.test.js`: **7/7** (was 6; +1 new)
- `test/core/briefDiscovery.test.js`: **11/11** (was 8; +3 new, 1 rewritten to match the new `readdirSync`-based scan)
- `test/core/rosterBulk.test.js` + `test/server/rosterBulk.test.js` together: **17/17** (core file was 11; +2 new; server file unchanged at 6)

Full suite, serial (`npm.cmd test`, `--test-concurrency=1`), run before starting and again after all changes:
- **After: 999 tests, 183 suites, 999 pass, 0 fail, 0 cancelled, 0 skipped, exit code 0.**

## Not done (per the brief's constraints)

No commits, no stash, no push, no installs, no subagents, no credentials, no global config, no writes to MAIN
or any other worktree, no live 6097/6099, no process listing or killing. One stray scratch file
(`tmp/repro-root`, `tmp/repro.mjs`) created early while reproducing F2's original-bug claim was found and
removed from the worktree before finishing; all later scratch work used the job's own `tmp` directory.

---

# Round 2 — the eight PM rulings from BRIEF-BUNDLE-F-round2.md

Round-1 review (Opus, SOURCE FAIL) held F3 and F6, and F4's per-folder error, stable cap and fail-closed
behaviour. It found F1-a, F1-b and F2-b not holding, and asked for ownership rulings on F2-a and F4-a; the
brief widened ownership to `src/core/store.js` for exactly two functions (`validateAnnotationSnapshot`,
`validatePost`). All eight rulings are implemented below, and every change has a test.

## R1 (F1-a) — the refusal names the offending path as written, and says what it is

`snapshotTargetContainmentIssue` (`src/core/annotationSnapshot.js`) now returns, with the path exactly as the
config writes it:
- a plain folder outside the project → `派遣数据目录在项目之外：<config.paths.data>` (a plain folder is never
  called a link; the words 符号链接 / 联接点 appear only when a link really is involved);
- a link that escapes → `派遣数据目录里的联接点指向项目之外：<path>` (the data folder itself, or the
  `dispatch-briefs` junction, whichever the config writes).

**Tests:** `refuses a data directory outside the project before assign, creating nothing (F1)` updated to
assert the exact sentence plus `doesNotMatch /符号链接|联接点/`; `refuses a dispatch-briefs junction resolving
outside data before assign, creating nothing when supported (F1)` updated to the new exact sentence.

## R2 (F1-b) — dangling links are detected with `lstatSync` in a try/catch, before assign

Two small helpers — `linkState` (`'missing' | 'link' | 'plain'`, via `fs.lstatSync` in a try/catch) and
`linkResolves` (`fs.statSync` in a try/catch) — replace the old `existsSync` probes, which follow the link and
therefore report a dangling junction as absent. A dangling `dispatch-briefs` junction is now refused before
assign with `派遣简报目录是一个指向不存在位置的联接点：<path-of-the-junction>`; a link whose target exists
is still checked by its real target (same code as R1); no branch creates anything. As same-mechanism hardening
for the bundle title (catch dangling junctions before assign), a data path that is itself a dangling junction
is refused too, as `派遣数据目录是一个指向不存在位置的联接点：<path>`.

**Tests:** added `refuses a dangling dispatch-briefs junction before assign, naming the path and creating
nothing (F1)` (a real junction; asserts the exact sentence and that the missing target stays uncreated);
updated the F1 junction test above; added `refuses a data path that is itself a junction to a missing target,
before assign (F1 hardening)`.

## R3 (F2-b) — the removed write-time check is restored, and the case is refused before assign

`writeAnnotationSnapshot` again ends with the exact original line —
`if (relative === '..' || relative.startsWith('../')) fail('批注快照路径在项目之外', 'snapshot_containment');`
— same sentence, same `snapshot_containment` code. The comment now explains why it is reachable: the realpath
checks pass when the data path is outside as written but inside by real path (a junction planted back into the
project), while the reference stored below still carries the `..` the config wrote. The same case is refused
earlier, in `snapshotTargetContainmentIssue`, with the path named:
`批注快照路径在项目之外：<config.paths.data>`.

**Tests:** added `refuses a data path that is outside as written but a junction back inside the project,
before assign (F2)`; added `refuses a snapshot write whose data path is outside as written but a junction back
inside the project (F2)` (asserts the restored exact sentence and `snapshot_containment`).

## R4 (F2-a) — every `validateAnnotationSnapshot` message is plain Chinese

The messages in `src/core/store.js`'s `validateAnnotationSnapshot` now name the field in everyday Chinese
(e.g. `批注快照的页面编号无效`, `批注快照路径必须在项目根目录之内`); the conditions, their order, and the
returned object are unchanged.

**Test:** `rejects a malformed annotation snapshot reference with plain Chinese messages (F2)` in
`test/core/store.test.js` — page id, title, count, date, digest, relative path, root containment and
quest-dir containment, plus a valid reference that passes.

## R5 (F4-a) — a brief path that is only a dangling link is refused at POST

`validatePost` (`src/core/store.js`) now lstats the brief path — only when the directory-only
`briefPathAllowed` rule has already passed — and, if it exists as a link whose target is missing, returns
`errors.brief = 简报路径是一个指向不存在位置的联接点：<brief>`. Nothing is posted. A brief that is simply
not written yet stays legal, and `briefPathAllowed`'s directory-only rule is untouched.

**Tests:** added `refuses a brief path that exists only as a dangling junction, already at POST (F4)` in
`test/core/store.test.js` (a real junction through `QuestStore.post`; asserts the exact Chinese error,
`store.get('RUN-31') === null`, and zero events — nothing is persisted). The round-1 test that only covered the
discovery shelf was renamed to `reports a dangling junction on the discovery shelf instead of surfacing it,
with a Chinese reason (F4, discovery shelf only)`.

## R6 (F4 observation) — full read, names-only sort

`scanDirectory` (`src/core/briefs.js`) still reads the whole listing in one call — a stable alphabetical slice
needs every name — but now projects the dirents down to a `name → 'link' | 'md'` map first and sorts only the
names, so what is held after classification is plain strings, not dirent objects. The comment says plainly
that the caps bound what is kept, not what is read. Behaviour is identical (the same deterministic slice); the
round-1 stable-cap and per-folder-EIO tests still lock it.

## R7 (F6 observation) — empty reason vs non-empty reason, and 空闲 wording

`normalizePatch`'s collapse of "never sent" and "explicit `''`" into the same value is now documented as
intentional: neither names a new reason, so a repeated `available` keeps the existing reason; only a non-empty
reason replaces it, and clearing a reason is a single-card action (`statusChange`'s comment updated). The bulk
note and the quota-evidence refusal now use the single-card label 空闲 throughout, never 可用.

**Tests:** added `a bulk available with an explicit empty reason keeps the existing reason, same as no reason
at all (F6)` and `a bulk available with an explicit non-empty reason replaces the old reason (F6)`; the
derived-quota test now also asserts the refusal message and `statusNote` contain no 可用.

## R8 — the security slice is untouched

Only `validateAnnotationSnapshot` and `validatePost` were edited inside `store.js`; the post-time
brief-folder allowlist message, review-override, and cancellation code are untouched.

**Ownership exception (documented):** `validatePost` needs `fs.lstatSync`, and `fileStatusFor`/`briefUsable`
cannot distinguish a dangling link from a missing file without an assign, so one `import fs from 'node:fs';`
line was added at the top of `store.js` — the only change outside the two named functions.

**Round-1 deferred rows now resolved:** the two `store.js` rows in the Deferred table above (F2-partial
translation, F4-partial POST-time dangling junction) are done in this round. F5 (`roster.js`) remains deferred
— outside this slice.

## Changed files after round 2 (SHA-256, current worktree content — supersedes the block above)

```
d00ed9c6e8dc2b10f35127d265f07c2791e0375dfe042efbe3aa804b66c36d4a  src/core/annotationSnapshot.js
1d67b61b49f93a433647030337a3a7e363fd97aa86ec4f90c68e70c5e4c3301c  src/core/briefs.js
794bee160f758f517bcd1e48373d928d2485b53c681eb91cfa12141c141c21a0  src/core/reviewRequest.js
90c271370dc08eb06764e16eda42ad2d8903cc382f17d1d76fb49087df3f4d4f  src/core/rosterBulk.js
7cc37f38a23238894faf5089b25c6bd68e5a01290bbeda9a52e836f0e998b196  src/core/store.js
00736f8e8eafbb50cca978aca0e798a0c0e6b1d0e40d07ffdf826053251f3ff8  test/core/annotationSnapshot.test.js
661cfa1d631d93cf0e1a59e25fa5c6644b2c8a78c889e851bbf9e54a23ae2513  test/core/briefDiscovery.test.js
5183edd86ce87ee739a9f16783e763a4a9c3eb4f86e6176ae70e7586cbed7095  test/core/reviewRequest.test.js
64f79bf7e7aa14e5b6fdff81b7120030b3e2c7d16f99acf6e999e95197a9dee2  test/core/rosterBulk.test.js
697c33842b13587bb3f78aaad301941a074bc012a363a552c7ad8cedefeb1976  test/core/store.test.js
```

All ten paths round 1 + round 2 (`src/core/store.js` and `test/core/store.test.js` are the round-2 additions).
`git status --porcelain` shows exactly these ten tracked files modified, nothing else; only the brief, the
review and this report are untracked.

## Round-2 test counts

- `test/core/annotationSnapshot.test.js`: **19/19** (was 15; +4 new tests, 2 existing tests updated for the new
  sentences).
- `test/core/store.test.js`: +2 new tests (F2-a Chinese messages; F4-a POST dangling junction).
- `test/core/rosterBulk.test.js`: +2 new tests (F6 explicit empty / explicit non-empty reason) and 2 new
  assertions in the derived-quota test.
- `test/core/briefDiscovery.test.js`: one test renamed; no count change.
- Full suite, serial (`npm.cmd test`, `--test-concurrency=1`), before and after this round:
  - **Before (round-1 content): 999 tests, 183 suites, 999 pass, 0 fail, 0 cancelled, 0 skipped, exit 0.**
  - **After (round-2 content, clean run): 1007 tests, 183 suites, 1007 pass, 0 fail, 0 cancelled, 0 skipped,
    exit 0.**
  - Delta: +8 tests, all green. One intermediate full run hit a pre-existing timing flake in
    `test/cli/worker-artifacts.test.js` (15 subtests `cancelledByParent`, 0 failures; that file is unmodified
    by this slice, passes 25/25 alone, and the clean run above follows it) — noted so the reviewer does not
    attribute it to this slice.

## Round 2 — not done (per the brief's constraints)

No commits, no stash, no push, no installs, no subagents, no credentials, no global config, no writes to MAIN
or any other worktree, no server started, no process listing or killing. Verification scratch logs were
written under the job's own `tmp` directory and removed before finishing.
