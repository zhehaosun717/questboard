#!/usr/bin/env node
// questboard — local quest board for dispatching AI coding agents.
//
//   questboard init [<dir>] [--name "My Game"] [--port 6097] [--force]   (config + wrapper + brief + roster)
//        [--lane aider="aider --model {model}"]      add a lane for your own agent CLI; repeat for more
//   questboard serve [--project <dir>] [--port <n>]
//   questboard port <n> [--project <dir>]                           (改项目配置里的端口；旧配置留一份带时间的备份，重启后生效)
//   questboard post --package RUN-4 --brief docs/briefs/RUN-4-x.md [--kind code|review|art|tool|owner]
//        [--parents A-1,B-2] [--conflicts C-3] [--lanes codex,agy] [--priority 1|2|3] [--needs-owner "question"] [--title "..."]
//        [--review none|mechanical|model] [--mechanical-check "cmd"]   (交付后复核方式：默认 model 进待安排复核)
//   questboard list [--status posted]
//   questboard get <id> | show <id> [--json] [--all]                (one quest: revision, worker, dispatch history, detail, files; --all 完整名单，默认长名单只列前 5 张)
//   questboard release <id> --detail "how you confirmed the worker stopped"
//        (frees a stalled quest; a running quest whose process tree verifies empty releases directly, otherwise cancel first)
//   questboard status RUN-4 done|delivered|reviewing|needs_owner|owner_playtest|lane_limited|superseded|cancelled|failed [--status <status>]
//        [--detail "..."] [--by coordinator|owner] [--evidence-ref kind=report,digest=<sha>,attemptId=<id> ...] [--note "..."]
//        (--evidence-ref/--note only take effect on `done`: they record an acceptance naming --by as the actor,
//        matched against the quest's own current-attempt evidence; refused if a ref does not match)
//   questboard ruling RUN-4 --text "..."
//   questboard update RUN-4 [--title "..."] [--brief docs/briefs/x.md] [--parents A-1,B-2] [--conflicts C-3]
//        [--lanes codex,agy] [--needs-owner "question"] [--hold "原因，空串解除"] [--needs runs-node,web] [--files a,b]
//        [--review-page robot8] [--if-revision 3] [--by who]
//        (correct title/brief/parents/conflicts/allowedLanes/needsOwner on a posted quest; refused while a worker holds its slot)
//   questboard batch FIX-44,FIX-45 [--waiting-on FIX-48] [--by who]   (卡面显示「和 … 一批 · 等 …」)
//   questboard assign RUN-4 --adventurer codex-luna [--request-key run4-a] [--if-revision 3]
//   questboard adopt RUN-3 --adventurer codex-luna --name run3      (a worker started by hand; runs nothing)
//   questboard cancel RUN-3 --reason "为什么"                        (--detail 与 --reason 等价)
//   questboard resolve RUN-3 --reason "你怎么确认 worker 停了" --ack [--reopen]
//        (--reopen 自带确认，并把任务放回 posted 重新招人，派单史保留)
//   questboard hook-log <quest> <hookId>                             (verification hook's bounded log)
//   questboard doctor                                               (read-only setup check)
//   questboard card list | card add --id x --name X --provider P --lane codex --model m [--family m] [--variant high]
//        [--agent build] [--billing subscription|plan|payg|free] [--max-parallel 1] [--strengths code,review] [--notes "..."] [--env KEY=VALUE ...]
//   questboard card edit <id> [--name X] [--model M] [--variant V] [--note "..."] [--env KEY=VALUE ...]   (写前留带时间的名册备份)
//   questboard card status <id> <available|limited|broke|paused|disabled> [--reason "..."] [--by who]
//   questboard roster path | roster import <old roster.json> [--dry-run | --force (merge) | --replace --force (full swap)]
//   questboard brief dismiss <package> [--brief <path>] [--note "..."]   (货架归档：板外完成/忽略；brief undismiss <package> 撤销)
//   questboard board post --title "..." --body "..." [--tag t] [--author coordinator]   (--author defaults to coordinator)
//   questboard board reply --thread <id> --body "..." [--author coordinator] | list | read | close | inbox [options]
//   questboard watch [--from-start]                                 (one JSON event per line; for Monitor)
//   questboard mcp [--author coordinator] [--url http://127.0.0.1:6097]   (MCP server over stdio)
//
// Every command finds questboard.config.json in the current folder or a parent, or takes --project <dir>.
import { commands } from './commands.js';

// One usage table per subcommand, printed verbatim by --help/-h — anywhere in that subcommand's args,
// without a project, a server or any write. Kept in sync with the header comment above.
const USAGE = {
  init: 'usage: questboard init [<dir>] [--name "My Game"] [--port 6097] [--force] [--lane aider="aider --model {model}" ...]\n  一键初始化项目：写配置、拷 worker 包装脚本和样例 brief、建名册；--lane 可重复，接你自己的 agent CLI。',
  serve: 'usage: questboard serve [--project <dir>] [--port <n>]\n  启动这个项目的看板服务器。',
  port: 'usage: questboard port <n> [--project <dir>]\n  把项目配置里的端口改成 n（旧配置留一份带时间的备份），重启看板服务器后生效。',
  post: 'usage: questboard post --package RUN-4 --brief docs/briefs/RUN-4-x.md [--kind code|review|art|tool|owner]\n  [--parents A-1,B-2] [--conflicts C-3] [--lanes codex,agy] [--priority 1|2|3] [--needs-owner "问题"] [--title "..."]\n  [--review none|mechanical|model] [--mechanical-check "命令"] [--supersedes OLD-1] [--hold "原因"] [--needs runs-node,web] [--files a,b] [--by coordinator]\n  [--origin machine-check --check "unity recompile"]\n  --review 决定交付后怎么复核：none=等 coordinator 验证；mechanical=交付后自动跑一次机械自检记结论（需 --mechanical-check）；model=进待安排复核（默认）。\n  --origin/--check 标明这张卡是机器检查出来的（卡面和派单史显示「coordinator 快速通道：<检查名>」），两个一起给。',
  list: 'usage: questboard list [--status posted] [--project <dir>] [--url <base>]\n  列这个项目的委托，一行一张。',
  get: 'usage: questboard get <id> | show <id> [--json] [--all] [--report] [--evidence]\n  读一张委托：第几版、worker、派遣史、最近动态、可改文件、可接手名单。长名单默认只列前 5 张 +「等 N 张」，--json 或 --all 给全量；\n  --report 打印这次派遣的完整报告原文；--evidence 打印这次派遣的证据。',
  release: 'usage: questboard release <id> --detail "怎么确认 worker 已经停了"\n  释放一个 stalled 的任务；进程树已核验为空的运行中任务也可直接释放，验证不为空会拒绝并说明。',
  status: 'usage: questboard status <id> <done|delivered|reviewing|needs_owner|owner_playtest|lane_limited|superseded|cancelled|failed|...> [--status <status>]\n  [--detail "..."] [--by coordinator|owner] [--note "..."] [--evidence-ref kind=report,digest=<sha>,attemptId=<id> ...]\n  例：questboard status RUN-4 done --detail "验收完成"。status 值也能用 --status 给；值不合法时报这个用法。',
  ruling: 'usage: questboard ruling <id> --text "..." [--by owner]\n  给等裁决的任务一个裁决，并关掉它回答的问题线程。',
  update: 'usage: questboard update <id> [--title "..."] [--brief docs/briefs/x.md] [--parents A-1,B-2] [--conflicts C-3]\n  [--lanes codex,agy] [--needs-owner "问题"] [--hold "原因，空串解除"] [--needs runs-node,web] [--files a,b] [--review-page robot8]\n  [--if-revision 3] [--by who]\n  只改传了的字段，其余不动；worker 占着这个任务时会被拒绝，先 release 再改。',
  batch: 'usage: questboard batch <FIX-44,FIX-45,...> [--waiting-on FIX-48] [--by who]\n  一批至少两张卡；卡面会显示「和 … 一批 · 等 …」。',
  assign: 'usage: questboard assign <id> --adventurer <card> [--request-key k] [--if-revision 3] [--by owner|coordinator] [--max-files 3]\n  派一张卡去做；没给卡会用派遣规则里的默认卡。\n  --by coordinator（默认）只能派机器检查出来的小修复：卡上开了 coordinatorAssignable、任务 origin 是 machine-check/post-delivery-check、\n  可改文件不超过 --max-files（默认 3）个；其余任务请用 --by owner 派，拒绝时会说明差哪一条。',
  adopt: 'usage: questboard adopt <id> --adventurer <card> --name <worker> [--by coordinator]\n  登记一个手工启动、已经在跑的 worker；只记录，不启动任何东西。',
  cancel: 'usage: questboard cancel <id> --reason "取消原因"\n  --detail 与 --reason 等价，写清为什么取消。',
  resolve: 'usage: questboard resolve <id> --reason "你怎么确认 worker 已经停了" --ack [--reopen]\n  --reopen 自带确认，并把任务放回 posted 重新招人（派单史保留）；--detail 与 --reason 等价。',
  'hook-log': 'usage: questboard hook-log <quest> <hookId>\n  打印那条验证钩子的最近日志（限量）。',
  doctor: 'usage: questboard doctor [--project <dir>]\n  只读的装机检查：路径、派遣脚本、Git Bash、名册、密钥来源、正在跑的看板。',
  card: 'usage: questboard card list | card add --id x --name X --provider P --lane codex --model m [--family m] [--variant high]\n  [--agent build] [--billing subscription|plan|payg|free] [--max-parallel 1] [--strengths code,review] [--notes "..."] [--env KEY=VALUE ...]\n  | card edit <id> [--name X] [--model M] [--variant V] [--note "..."] [--env KEY=VALUE ...]\n  | card status <id> <available|limited|broke|paused|disabled> [--reason "..."] [--by who]\n  --env 可重复，值不许像密钥（密钥放本机环境变量）；card edit 写前先留一份带时间的名册备份。',
  roster: 'usage: questboard roster path | roster init [--force] | roster import <旧 roster.json> [--dry-run] [--force] [--replace --force]\n  名册文件在哪、建空名册、或从旧文件导入（默认合并，--replace 整体换掉）。',
  brief: 'usage: questboard brief dismiss <package> [--brief <path>] [--note "..."] [--by who] | brief undismiss <package> [--brief <path>]\n  货架归档：已在板外完成/忽略的 brief 从货架收起（可撤销）；undismiss 撤销。',
  board: 'usage: questboard board post --title "..." --body "..." [--tag t] [--author coordinator]\n  | board reply --thread <id> --body "..." [--author coordinator] | board list | board read | board close | board inbox\n  留言板。--author 默认 coordinator。',
  watch: 'usage: questboard watch [--from-start] [--project <dir>]\n  事件文件每行一个 JSON，给 Monitor 用。',
  mcp: 'usage: questboard mcp [--author coordinator] [--url http://127.0.0.1:6097]\n  走 stdio 的 MCP 服务。',
};
USAGE.show = USAGE.get;

const OVERVIEW = [
  'usage: questboard <' + Object.keys(commands).join('|') + '> [options]　（questboard <子命令> --help 看那个子命令的参数表）',
  '',
  '常用：init · serve · post · get · assign · adopt · status · release · resolve · cancel · update · batch · card · doctor · watch · mcp',
  '每个子命令都从当前目录（或父目录）找 questboard.config.json，或用 --project <dir> / --url <base> 指定。',
].join('\n');

const [name, ...args] = process.argv.slice(2);
const wantsHelp = args.includes('--help') || args.includes('-h');
// FB2-06 item 2: --help/-h anywhere in a subcommand's args prints only that subcommand's parameter table —
// no project lookup, no request, no write. A bare --help (or an unknown subcommand) prints the overview.
if (name === '--help' || name === '-h') {
  process.stdout.write(`${OVERVIEW}\n`);
  process.exit(0);
}
if (wantsHelp) {
  if (commands[name] && USAGE[name]) { process.stdout.write(`${USAGE[name]}\n`); process.exit(0); }
  if (commands[name]) { process.stdout.write(`${OVERVIEW}\n`); process.exit(0); }
  process.stderr.write(`${OVERVIEW}\n`);
  process.exit(2);
}
if (!commands[name]) {
  process.stderr.write(`${OVERVIEW}\n`);
  process.exit(2);
}
Promise.resolve(commands[name](args)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
