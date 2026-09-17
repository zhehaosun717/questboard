# Independent review, round 1: backlog Bundle F

- **Reviewer:** Claude Opus 5 (high). I changed nothing outside this job's tmp folder.
- **Candidate:** worktree `E:/questboard/.claude/worktrees/qb-fb-bundle-f`, branch `cx/bundle-f`, HEAD `068a322`, 8 uncommitted paths.
- **Writer report:** `local/workers/bundle-f/REPORT-round1.md`.
- **Probe scripts:** `tmp/probe-f1f2.mjs` and `tmp/probe-f346.mjs`.
- **Probe logs:** `tmp/main-baseline.log` and `tmp/overlay.log`.

## 1. Frozen hashes and scope

- **Before and after my work:** all 8 hashes match `frozen-candidate.sha256`.
- **`git status`:** shows exactly the 8 frozen paths. HEAD is still `068a322`.
- **`git diff --stat 068a322 e5d2387 -- <8 paths>`:** empty, so MAIN has not touched these files and the overlay is byte-exact.
- **Out-of-scope files:** none touched. `roster.js`, `store.js`, `questRoutes.js` and `patterns.js` are unchanged.

## 2. F1: pre-assign containment in `prepareAnnotationSnapshot`

### Order in `src/server/dispatcher.js` `assign()` (read only)

1. `withFileSets` and the rules checks
2. `roleCardBriefReason`
3. `prepareAnnotationSnapshot` (line 388). A throw here becomes a 409 `refused`.
4. `planDispatch` and `preflight`
5. `store.assign` (line 405)

So the new check really does run before an attempt is minted. **Confirmed.**

### Probes

I built temporary projects under `tmp/probes`. For each probe I listed the whole parent tree before and after the check.

| Probe | Clean MAIN e5d2387 | Candidate | Tree unchanged |
|---|---|---|---|
| P1: `dataDir: '../outside-data'` (exists) | accepted (caught only after assign) | refused `snapshot_containment`: 「派遣数据目录不能用：目录在项目外（符号链接或联接点逃逸）」 | yes |
| P1b: `dataDir` outside, folder missing | accepted | refused, same text | yes |
| P2: `dispatch-briefs` junction to an existing outside folder | accepted | refused: 「批注快照目录不能用：目录在项目外（符号链接或联接点逃逸）」 | yes |
| P2b: `dispatch-briefs` junction to a **missing** outside folder (dangling) | accepted | **accepted.** The later write fails after assign with `snapshot_write_failed`: 「批注快照目录创建失败：ENOENT」 | yes |
| P2c: `dispatch-briefs/ART-39` junction to an outside folder | accepted | accepted (caught after assign by `safeAttemptTarget`) | — |
| P3: normal in-project data folder, missing, then present | accepted | accepted. `prepare` creates nothing. A direct write then creates `.questboard-data/dispatch-briefs/ART-39/…` | yes |

### F1 findings

- **F1-a (MEDIUM, required by the brief):** the refusal does **not** name the path.
  - The brief asks for "Chinese reason naming the path". Both new messages only add a prefix to the generic `realpathContainmentIssue` text.
  - The reason is also misleading for P1/P1b. A plain folder outside the project is reported as 「符号链接或联接点逃逸」, but no link is involved.
  - **Fix:** include `config.paths.data` or the `dispatch-briefs` path in the message, e.g. `派遣数据目录不能用：<path>（…）`.
- **F1-b (LOW–MEDIUM):** a dangling `dispatch-briefs` junction is not refused before assign (P2b).
  - **Cause:** `snapshotTargetContainmentIssue` uses `fs.existsSync(briefsDir)`, which follows the link and returns false for a dangling junction. The check then treats the folder as "not created yet".
  - **Effect:** every attempt still leaves a failed dispatch row. That is exactly the O1 cost this row was meant to remove. It still fails closed, and nothing is created outside.
  - **Fix:** detect the link with `fs.lstatSync` (with try/catch). Refuse a link whose target is missing, or run the containment check on the link's own target (`readlinkSync`).
- **Observation (not required by the row):** a package-level junction (P2c) is still caught only after assign.

## 3. F2: missing data folder, Chinese messages, removed branch

- **Missing data folder:** a direct `writeAnnotationSnapshot` with no data folder succeeds (P3). `safeAttemptTarget` already creates the folder on `068a322`, so O2's 「项目根目录不可读」 no longer occurs.
  - The new pre-check leaves a missing folder alone, and a test locks that in.
  - The failure path 「派遣数据目录创建失败：<code>」 names the folder.
  - **Holds.**
- **F2-a (ownership conflict, not delivered):** the `validateAnnotationSnapshot` messages are still English (P5: `annotationSnapshot.page has an invalid page id`).
  - The function is in `src/core/store.js:100-115`, which the brief excluded. It is unchanged on MAIN e5d2387.
  - The writer disclosed this. **Needs a PM ruling:** allow `store.js` or re-scope the row.
- **F2-b (LOW, regression): the removed branch was reachable.**
  - **Probe P4:** `dataDir: '../datalink'`, where `../datalink` is a junction back to `<root>/.inner-data`.
  - `realpathContainmentIssue` passes, because the real path is inside the project. The path, as written, is outside, so `path.relative(root, file)` starts with `../`.
  - **Clean MAIN:** the removed line refused it with `snapshot_containment` and 「批注快照路径在项目之外」.
  - **Candidate:** the write returns `path: "../datalink/dispatch-briefs/ART-39/ART-39-attempt-1.md"`. `store.recordAnnotationSnapshot` then throws the English `annotationSnapshot.path must stay under the project root`.
  - The dispatcher still settles this after assign (503), so it still fails closed. But the reason is now English, and its code changes from `snapshot_containment` to the fallback `annotation_snapshot`.
  - The writer's comment "would never be reachable" is wrong.
  - **Fix:** keep the check, translated as it already was. Or also refuse this case before assign by comparing the data path as written, not only its real path.

## 4. F3: review brief for a parent whose brief is unknown

I ran real `requestReview` calls (fake store object, real `withFileSets`) on temporary projects:

| Parent brief | What the review brief says |
|---|---|
| readable | `The files that brief allowed it to change:` plus `src/a.js`, `src/b.js` |
| oversized | 「- 委托允许改的文件列表现在不知道：文件过大（2.0MB，上限 2MB）」 |
| unreadable (a directory where the file should be) | 「…现在不知道：文件读取失败（EISDIR）」 |
| missing | 「…现在不知道：文件不存在或状态不可读」 |

- **Privacy:** the reason strings contain no absolute paths, so writing `briefUnknownReason` into the brief file does not leak one.
- **Test gap (minor):** the writer's unit test uses a hand-built parent.
- **Wording nit:** "2.0MB，上限 2MB" reads oddly for a file just over the limit. This wording predates the candidate.
- **Result: holds.**

## 5. F4: `src/core/briefs.js`

### Per-folder read error

- **Real folder error:** `docs/b1` configured but a file on disk → `errors: [{folder:'docs/b1', reason:'目录不可读（ENOTDIR）'}]`. `RUN-12` from `docs/b2` is still returned.
- **Stubbed `fs.readdirSync` EIO on `docs/b2`:** only that folder reports 「目录不可读（EIO）」, and `RUN-13` from `docs/b1` is still returned.
- `opendirSync` is no longer called during discovery.
- **Result: holds.**

### 50k cap

- **How it works now:** `readdirSync(withFileTypes)` reads the full listing, sorts it with `localeCompare`, and only then applies `MAX_DIR_ITERATE`.
- **Probe:** the same 50003 entries in forward and in reversed order gave the identical result `["AAA-1","BBB-2"]`.
- **Result: holds** (stable on one machine; the order follows the machine's ICU collation).
- **Note (LOW, PM acceptance):** the cap no longer limits the work, only which entries are kept. A folder with millions of entries is now read fully into memory and sorted on every snapshot. The old streaming loop stopped at 50k, and its comment gave that as the reason for the cap. The writer disclosed the change. A stable choice does require seeing every name, so this is a trade-off to accept, not a bug.

### Dangling junction at POST

- **F4-a (ownership conflict, not delivered):** `new QuestStore(config).post({package:'RUN-31', brief:'docs/briefs/RUN-31-x.md'})` with a dangling junction at that path is **accepted**.
  - It later fails closed: `briefUsable` returns false, so dispatch reports `brief_missing`.
  - Closing this at POST needs `store.js`/`validatePost`, which the brief excluded. The writer disclosed it.
- **Misleading test:** the new test "refuses a dangling junction … on the discovery/post path" covers only the discovery shelf. That shelf already skipped all links on base, so the test adds no new behaviour, and its name overstates what it covers.
- **Needs a PM ruling.**

### Everything else in F4

- **Held quest with a deleted brief:** `fileStatusFor`/`withFileSets` are unchanged, and `test/core/briefFailClosed.test.js` passes in the overlay run. **Holds.**
- **Symlink entries:** handling is unchanged. `isSymbolicLink()` still sends them to `skippedLinks`, and nothing else changed. **Holds.**

## 6. F6: `rosterBulk.js`

- **Refusal text:** 「卡片 c1 当前仍有具体的限额证据，不能批量设置为可用；请在单卡中确认额度已恢复（或手动改为可用）后再试」. The preview `statusNote` also points to the single card. **Holds.**
- **Reason kept:** a card acknowledged with 「已手动确认额度恢复」, then a bulk `{status:'available'}` → `changed 0, unchanged 1`. The status log still has only that one record with its reason. **Holds.**
- **Observation (LOW):** an explicit `{status:'available', reason:''}` is now also a no-op, so the owner can no longer clear a reason through bulk. `normalizePatch` turns a missing reason into `''`, so the two cases cannot be told apart.
- **Wording nit:** the same `statusNote` says 「批量设为空闲」 and then 「手动改为可用」. The single-card label for `available` is 「空闲」 (`web/src/lib/labels.ts`), while `BulkActions` uses 「可用」.

## 7. Contracts

- **Events:** no event name or shape changed.
- **Dependencies:** none added.
- **Processes:** no process listing or PID use.
- **Wording:** every new refusal is Chinese. The only non-Chinese text left is F2-a (pre-existing) and F2-b (English now reaches the caller where Chinese did before).

## 8. Integration

- **Setup:** `git archive e5d2387` into `tmp/main-e5d2387`, then the 8 frozen files copied over it. Hashes were re-checked after the copy. No merge was needed.
- **Clean MAIN e5d2387,** `node --test --test-concurrency=1 "test/**/*.test.js"`: **992 tests, 182 suites, 992 pass, 0 fail**, exit 0.
- **MAIN plus the overlay,** same command: **1001 tests, 183 suites, 1001 pass, 0 fail, 0 skipped**, exit 0. That is +9 tests, matching the writer's 3 + 1 + 3 + 2.
- **Junction tests:** on this machine the two junction tests created real junctions, as my probes did, so they did not take their early-return skip.

## Summary of findings

| # | Sev | Row | Finding |
|---|---|---|---|
| F1-a | MEDIUM | F1 | The refusal does not name the path, which the brief explicitly requires. A plain outside folder is mislabelled as a link escape. |
| F1-b | LOW–MED | F1 | A dangling `dispatch-briefs` junction passes the pre-check (`existsSync` follows the link) and still leaves a failed dispatch row after assign. |
| F2-b | LOW | F2 | The "unreachable" line was reachable: a `dataDir` outside as written but inside by real path. Removing it swaps a Chinese `snapshot_containment` refusal for an English store error. |
| F2-a | PM ruling | F2 | `validateAnnotationSnapshot` is still English; it lives in `store.js`, which the brief excluded. |
| F4-a | PM ruling | F4 | A dangling junction is still accepted at POST (`validatePost` is in `store.js`, excluded). The test that claims "post path" only covers discovery. |
| obs | LOW | F4 | A full directory read and sort on every scan; the cap no longer limits the work. |
| obs | LOW | F6 | An explicit empty reason cannot clear a reason through bulk; 空闲/可用 wording is mixed. |

- **Holding under my probes:** F3 and F6. F4 holds for the per-folder error, the stable cap and fail-closed.
- **Not holding:** F1 misses its stated requirement (the path is not named) and leaves the dangling-junction case after assign. F2's removed branch was reachable, and removing it changed the Chinese refusal to an English error.
- **Scope conflicts:** F2-a and F4-a need a PM decision (widen ownership to `store.js`, or re-scope the rows).
- **Tests:** the export is green.

SOURCE FAIL
