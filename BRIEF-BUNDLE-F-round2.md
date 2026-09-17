# Bundle F, round 2: name the path, catch dangling junctions before assign and at POST, restore the removed check, Chinese snapshot validation

ACTIVE 2026-09-17. Executor: OpenCode Go (deepseek-v4.1-flash max). Independent review afterwards (round 2).
Worktree: E:/questboard/.claude/worktrees/qb-fb-bundle-f (your round-1 edits are there, uncommitted), branch cx/bundle-f, base 068a322. Do not rebase; the PM merges onto MAIN afterwards. Install nothing.

## Round-1 review: E:/questboard/local/workers/bundle-f/REVIEW-round1.md (copy at ./REVIEW-round1.md), Opus, SOURCE FAIL
F3 and F6 hold; F4 holds for the per-folder error, the stable cap and fail-closed. Not holding: F1-a, F1-b, F2-b; ownership rulings needed for F2-a and F4-a.

## PM rulings (ownership widened to src/core/store.js for exactly the two functions named)
1. F1-a: the pre-assign refusal names the offending path as written (`config.paths.data` or the dispatch-briefs path) and says what it is: a plain folder outside the project is 「派遣数据目录在项目之外：<path>」, a link that escapes is 「派遣数据目录里的联接点指向项目之外：<path>」. Never say 符号链接 when no link is involved.
2. F1-b: detect links with `fs.lstatSync` in a try/catch; a dangling `dispatch-briefs` junction (target missing) is refused before assign with 「派遣简报目录是一个指向不存在位置的联接点：<path>」; a link whose target exists is checked by its real target. Nothing is created by the check.
3. F2-b: put the removed check back (a data path that is outside the project as written, even when its real path is inside, is refused with the original `snapshot_containment` code and the Chinese sentence 「批注快照路径在项目之外」), and also refuse that case before assign. Fix the comment: it was reachable (junction back into the project).
4. F2-a: translate every message of `validateAnnotationSnapshot` in src/core/store.js (around lines 100–115) to plain Chinese that names the field (for example 「批注快照的页面编号无效」, 「批注快照路径必须在项目根目录之内」); keep the same error codes and the same conditions; update the tests that quote them.
5. F4-a: in `validatePost` (src/core/store.js), a brief path that exists only as a dangling link is refused at POST with 「简报路径是一个指向不存在位置的联接点：<path>」 (use `briefUsable`/`fileStatusFor` or `lstatSync`; do not change the directory-only `briefPathAllowed` rule for other cases). Rename the misleading round-1 test so it says it covers the discovery shelf, and add a real POST-path test through `QuestStore.post` with a junction (skip cleanly with a stated reason only if junction creation needs privileges).
6. F4 observation: keep the full-read-then-sort approach (a stable cap needs every name), but keep the memory bounded: sort only the names, not the entries, and document in the comment that the cap now bounds what is kept, not what is read.
7. F6 observation: a bulk `available` with an explicit non-empty reason replaces the reason; with no reason field or an empty one it keeps the existing reason (document the empty-string case in the refusal-free path with a test). In the bulk note use 空闲 (the single-card label), never 可用.
8. Do not touch the security slice's areas of store.js (post-time brief-folder allowlist message, review-override, cancellation).

## Required
- Implement the rulings; keep every round-1 behaviour that held. Every change gets a test (test/core/annotationSnapshot.test.js, test/core/briefDiscovery.test.js, test/core/store.test.js or a new test/core file, test/core/rosterBulk.test.js). Chinese refusals name the path. No event or data-shape change, no new dependency.
- Run `npm.cmd test` (serial) before and after; all green.

## Rules for this executor
Write REPORT.md in this worktree BEFORE any optional extra check (append a "Round 2" section to the existing ./REPORT.md). Never start a server on a port outside 48100–48199; never list or kill processes; if something hangs, stop and report. No live 6097/6099.

## File ownership
src/core/annotationSnapshot.js, src/core/briefs.js, src/core/reviewRequest.js, src/core/rosterBulk.js, src/core/store.js (only `validateAnnotationSnapshot` and `validatePost`), and tests under test/core/ (plus test/server/ files quoting changed strings). Nothing else; not roster.js, not questRoutes.js.

## Delivery
./REPORT.md "Round 2" section: each ruling with the fix and its test, changed files with SHA-256 (all paths, round 1 plus round 2), exact counts. No commits, stash, push, installs, credentials, MAIN or other-worktree writes.
