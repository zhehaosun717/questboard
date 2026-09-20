# questboard 反馈第二册（QUESTBOARD_FEEDBACK_2.md）实施计划

> 给执行者（agent-teams 的 implementer / reviewer，或人工接手时）：按任务一节一节做，每个任务 =
> 先写失败测试 → 跑确认失败 → 最小实现 → 跑确认通过 → commit。每个任务验收标准写在任务标题下，
> 不满足验收标准不算完成。执行中遇到计划没写到的细节，以「缺数据就响亮报错、不编造回退值」和
> CLAUDE.md 的工作规则为准。

**Goal:** 把反馈第二册 34 条全部实现、测试、合并进 main（基线 e475044），恢复委托/复核流程的可靠性和速度。

**Architecture:** 全部改动留在现有五层（core 领域逻辑 / lanes 采集器 / server 派单与路由 / cli / web UI）。核心策略是
把「出错」从人眼发现改成机器发现：采集器与派单器补上死亡进程、启动即败、会话无响应、模型下线的自动识别；
评审批注进入派单材料闭环；交付前加可配置的自检钩子；最后才做 worktree/patch 的大改造（第 29 条，独立成最后一阶段）。

**Tech Stack:** Node 22 ESM（src/）+ node --test 串行（test/）+ React/TS/Vite（web/）+ vitest + Tauri 2（desktop/，本轮几乎不涉及）。

**状态基线:** main = e475044。Wastecape 看板运行在 127.0.0.1:6097（持久计划任务 questboard-wastecape），
改动服务端代码合并后要重启它并 curl /api/health 确认。

---

## 执行协议（所有任务遵守）

1. 在 E:/questboard main 上直接做，每完成一个任务 commit 一次（conventional message，**不带任何 AI 署名/模型名**）。
2. 每个行为变化必须带测试：core/server/cli 加 test/** 的 node --test 文件；web 加 web/src/**/*.test.tsx。
3. 改前 npm test 全绿，改后 npm test 全绿；动 web 再跑 cd web && npx vitest run。测试串行（--test-concurrency=1），别在测试文件里起常驻定时器。
4. UI 文案用中文、口语；拒绝必须说原因。文件 200–400 行、上限 800。
5. 不碰 local/、CLAUDE.local.md、.claude/、AGENTS.md（保持未跟踪）；不提交 web/dist。
6. 服务端行为改动合并后：npm --prefix web run build，再 MSYS_NO_PATHCONV=1 schtasks /run /tn questboard-wastecape 重启 6097，curl http://127.0.0.1:6097/api/health 确认。
7. 卡状态、任务状态等数据契约变更时，先翻 src/core/store.js 的 QUEST_STATUSES/迁移规则和 test/docs/contracts.test.js，同步更新契约测试。

---

## 批次与任务划分

| 批次 | 任务 | 条目 | 严重度 | 说明 |
|:--|:--|:--|:--|:--|
| A 派单可靠性 | FB2-01 | 5, 10, 23, 17.2 | 高×3 | 死亡/启动即败识别、包装脚本兜底 |
| A | FB2-02 | 18, 20, 26 | 高×3 | 评审批注闭环、owner_ruled |
| A | FB2-03 | 4, 19, 30, 31 | 高×1 | supersedes/hold/父卡 done/能力标签/files 抽取 |
| A | FB2-04 | 21.2, 21.3, 24, 25 | 高×1 | 复核范围快照、批次等待、收件箱提醒 |
| A | FB2-05 | 27, 28 | 高×2 | postDeliveryCheck 自检钩子 + 复核方式 |
| B CLI/名册/货架 | FB2-06 | 1, 2, 6, 7, 8, 13.2, 22 | 低-中 | CLI 硬化 |
| B | FB2-07 | 9, 10.顺带, 33/34 的计费字段 | 中-高 | 名册真实性、计费类型 |
| B | FB2-08 | 3, 16 | 中/低 | 货架 dismissed、逐文件计数 |
| C UI | FB2-09 | 11, 15 | 中×2 | 复选框排版两处 + 口径说明 |
| C | FB2-10 | 14, 32, 17.3 | 高×2 | 会话无响应 stalled、token 明细、启动日志入口 |
| C | FB2-11 | 12, 13 | 低×2 | 评审页过滤、art 交付自动 reviewPage |
| D 大改造 | FB2-12 | 33, 34 | 高×2 | 并发组 + coordinator 快速通道 |
| D | FB2-13 | 29 | 高 | worktree + patch 交付（最大改造，最后做） |

复核任务：FB2-R1（A 批）、FB2-R2（B+C 批）、FB2-R3（D 批）。

---

## FB2-01 worker 死亡 / 启动即败识别（条目 5, 10, 23, 17.2）

**Files:**
- Modify: src/lanes/collector.js（fileWorker 补死亡判定）、src/lanes/workers.js（workerState 结果解析）、src/server/dispatcher.js（对采集结果的响应：failed→卡状态）、src/core/dispatch.js（启动即败判定）、src/lanes/protocols.js（claude stream-json result、agy VERDICT 行）
- Modify: examples/basic/scripts/run-worker.mjs（信号兜底，验证现有 process.on('exit') 覆盖面）
- Test: test/lanes/collector.test.js、test/lanes/protocols.test.js、test/server/dispatcher*.test.js

**现状:** 通用包装脚本已用 process.on('exit') 写 .exit（第一册修复）；Wastecape 项目自带的 tools/*-run.sh 不在本仓库。
所以本仓库侧的正确修法不是再依赖包装脚本，而是看板侧识别。进程树是否为空用第一册的 jobObject 验证器
（src/core/jobObject.js + src/server/workerControlAdapters.js，cancellation 已在用）。

**验收（每一条都要有测试）：**
1. dispatched + 进程树验证为空 + 没有 .exit/.md/交付物 → state='failed'，reason 带 .out 最后几行原文（复用 tailText，上限同 LAST_TEXT_MAX）；不再等 stallAfterMinutes。
2. .out 最后几行匹配 401/AUTH/invalid_api_key（走 policy.bouncePatterns 同一入口）→ 派单响应里自动把卡记 limited（带原因原文）；.out 含 410/404/model-not-found → 卡记 broke（条目 9 的一半）。
3. claude 通道：没有 .exit 但 .out 末尾有 stream-json 的 "type":"result" → delivered；把 result 文本提取后由 dispatcher 写成 <outputDir>/<name>.md（采集器保持只读，写动作归派单器）。
4. agy 通道：.out 末尾 /^VERDICT:\s*(PASS|FAIL|PASS WITH FINDINGS)/i 解析进 entry.verdict，复核结论直接用（条目 21.1）。
5. 启动即败（17.2）：dispatch.js 里 wrapper 步骤非零退出 + 注册表没有新行 + .out 不存在 → 立即 failed，lastDetail 带 wrapper 日志（runScript 的 logFile）末尾原文，不等到 stalled。
6. 通用包装脚本：补 SIGINT/SIGTERM 处理（Windows 上 Node 收不到 SIGTERM，用 readline 或 process.on('exit') 已验证即可，补「被 taskkill 强制杀时靠看板侧识别、包装脚本不保证能写 .exit」的注释与测试说明）。

**Verify:** node --test test/lanes/collector.test.js test/lanes/protocols.test.js、npm test

---

## FB2-02 评审批注闭环（条目 18, 20, 26）

**Files:**
- Modify: src/core/annotationSnapshot.js、src/core/roleCard.js、src/server/dispatcher.js（派单材料）、src/core/store.js（新状态 needs_coordinator / owner_ruled + 迁移）、src/server/boardRoutes.js（批注保存路由 + 收件箱）、src/cli/commands.js（get 输出批注摘要）
- Modify: web/src/components/quest/*（退回重做区按钮）
- Test: test/core/annotationSnapshot.test.js、test/core/store.test.js、test/server/dispatcherAnnotation.test.js、test/docs/contracts.test.js

**验收：**
1. 「退回重做」重派时，派单材料里附带该评审页全部批注原文（新增材料文件 annotations.md，写进角色卡/planDispatch 的参数），卡面显示「本次派遣包含 N 条批注」；event 里带 annotationCount。
2. 批注原文含「coordinator」或 owner 勾选「需要 coordinator 处理」→ 不重派，状态转 needs_coordinator（新状态进 QUEST_STATUSES、事件 status_needs_coordinator），并往 coordinator 收件箱发一条（boardRoutes 现有 inbox 机制，写明哪张卡、哪个评审页）。
3. 重派前把旧交付目录打包存档（<outputDir>/<name>.bak-<时间戳> 或同级 zip），先备份后 spawn，任何一步失败不动旧目录。
4. 「退回重做」按钮旁加「交给 coordinator 重写 brief」：写一条带卡片号的消息进 coordinator 收件箱。
5. 批注保存失败要当场报错（保存路由只在 fs 写入成功后返回 200；UI 收到错误就显示，不吞）。
6. owner 保存评审结论时：状态 needs_owner → owner_ruled（新状态），收件箱带「通过 N / 不行 N / 需要修改 N」和批注原文；全部通过的 art 卡显示「等 coordinator 导入」且不可拖（rules 拒绝并说明）；get 输出带批注摘要（数量 + 前几条原文）。
7. 契约测试同步：QUEST_STATUSES、新事件名、needs_coordinator/owner_ruled 迁移。

**Verify:** node --test test/core/annotationSnapshot.test.js test/core/store.test.js test/server/dispatcherAnnotation.test.js test/docs/contracts.test.js、npm test、cd web && npx vitest run

---

## FB2-03 派单前置检查（条目 4, 19, 30, 31）

**Files:**
- Modify: src/cli/commands.js（post --supersedes/--hold/--needs/--files；update --hold）、src/server/questRoutes.js（POST 字段）、src/core/store.js（hold/needs/files 字段、superseded 迁移）、src/core/rules.js（拖卡检查）、src/core/roster.js（卡 capabilities）、src/core/config.js（lane capabilities/probes）、src/cli/doctor.js（探针实测）
- Test: test/core/rules.test.js、test/server/quest-detail.test.js、test/cli/doctor.test.js、文件集抽取相关测试（derive/briefDiscovery）

**验收：**
1. post --supersedes ART-BLOCK-2：旧卡自动转 superseded（写状态记录，detail 写「被 X 取代」）；拖 superseded 卡时弹确认（web 端 confirm）或拒绝并说明；get 显示取代关系。
2. post --hold "原因"：卡面显示原因，rules 拒绝拖放并说明；update <id> --hold "" 解除；coordinator/owner 都能解除。
3. 父卡满足 = 父卡 status === 'done'；delivered/reviewing 不算。拖卡时拒绝文案「父卡 X 还没验收」。
4. 能力标签：卡和 lane 都有 capabilities: string[]；post --needs runs-node,web；rules 检查 card∩lane 的能力 ⊇ needs，不满足的卡置灰并列出缺哪一项；任务有 --needs 时未声明能力的卡视为不满足。
5. doctor 探针：lane 配置 probes: { 'runs-node': ['node', '--version'] }，doctor 用 Git Bash 逐条跑（超时 10s），把结果写进机器名册卡的 capabilities（机器事实，不写状态不写日期注释）；doctor 输出每张卡测得的能力。
6. 条目 30：文件集只从「Files you may edit / 可改文件」节抽；post/update 支持 --files a,b,c 显式覆盖；post 回显打印抽取出的文件集，挂卡人当场可见。

**Verify:** node --test test/core/rules.test.js test/cli/doctor.test.js test/server/quest-detail.test.js、npm test

---

## FB2-04 复核正确性（条目 21.2, 21.3, 24, 25）

**Files:**
- Modify: src/server/dispatcher.js（派单前 git status --porcelain 快照）、src/core/reviewRequest.js（复核 brief 生成）、src/server/boardRoutes.js 或 src/server/boardStore.js（复核卡交付→coordinator 收件箱）、src/core/store.js + src/server/questRoutes.js + src/cli/commands.js（batch/waiting-on 元数据）、web 核验区排序
- Test: test/server/dispatcherDelivery.test.js、test/core/reviewRequest.test.js、test/server/board*.test.js

**验收：**
1. 派代码卡时若项目有 .git，先跑 git -C <root> status --porcelain（找不到 git 就记「无 git，无法快照」，不失败），存进 attempt 的 preDispatchChanges；复核 brief 里列出「派出前就已改动的文件（这些不算越界）」。
2. 复核 brief 里的 worker 摘要改成「完整报告路径：<outputDir>/<name>.out」+ 摘要尾巴；不再只给截断的尾巴。
3. 复核卡交付时往 coordinator 收件箱发一条（卡号 + 结论来源 + 等多久）。
4. 核验区按「已等多久」排序（delivered 起算），超过 policy.reviewBacklogRedAfterHours（默认 12，resolveConfig 校验正整数）的标红。
5. questboard batch FIX-44,FIX-45 --waiting-on FIX-48：一组卡的元数据记 batch 名单和 waitingOn；卡面显示「和 X、Y 一批 · 等 Z」；Z 交付时收件箱提醒 coordinator「该验收这批」。
6. 新元数据字段进 metadataUpdate 白名单 + 契约测试。

**Verify:** node --test test/server/dispatcherDelivery.test.js test/core/reviewRequest.test.js、npm test、cd web && npx vitest run

---

## FB2-05 交付自检钩子 + 复核方式（条目 27, 28）

**Files:**
- Modify: src/core/config.js（postDeliveryCheck: { run: [...], timeoutMs, failPattern, maxRounds } 校验）、src/server/dispatcher.js（delivered 之前跑检查）、src/core/dispatch.js（复用 runScript 跑命令）、src/cli/commands.js + src/server/questRoutes.js（post --review none|mechanical|model、--mechanical-check "cmd"）、src/core/store.js（attempt 轮次、checkResults）
- Test: test/server/dispatcherPostDeliveryCheck.test.js（新文件）、test/core/config.test.js（现有）

**验收：**
1. 配置校验：run 是非空参数数组（每个是独立 argv，不 join 再 split）、timeoutMs 正整数、failPattern 合法正则、maxRounds 1..5 默认 2；缺一个就启动时报错，不静默。
2. worker 出现交付证据后、写 delivered 之前：Git Bash 跑 run（cwd=项目根，环境同派单），把 stdout/stderr 存成 <outputDir>/<name>.check.log；输出匹配 failPattern → 不 delivered，事件 check_failed，lastDetail 带错误原文。
3. 回弹：失败后同 worker 同会话再修一轮——API 通道（opencode/agy session 型）给同一 session 发「自检失败，错误如下：…请修复」；文件通道用同 name 重跑 wrapper 并附加修复提示（沿用 lane.run 模板，经 env QB_FIX_HINT 传错误截断文本，wrapper 里补支持）；轮数上限 maxRounds，超了才 failed（lastDetail 含每轮检查输出）。
4. post --review none|mechanical|model（默认 model）：mechanical 需 --mechanical-check "cmd"；交付后自动跑一次（复用 postDeliveryCheck 的 runner，但不回弹），结果记成复核结论；none 交付后转 needs_coordinator（等 coordinator 验证）；model 才进 owner「待安排复核」列表。卡面显示复核方式。
5. 派单史里记每轮 check 的摘要与 exitCode。

**Verify:** node --test test/server/dispatcherPostDeliveryCheck.test.js test/core/config.test.js、npm test

---

## FB2-06 CLI 硬化（条目 1, 2, 6, 7, 8, 13.2, 22）

**Files:**
- Modify: src/cli/questboard.js（--help/-h 分发与 usage 表）、src/cli/commands.js（get 截断、status/resolve/release/cancel/card/update）
- Test: test/cli/cli.test.js、test/cli/quest-detail.test.js、test/cli/acceptance.test.js

**验收：**
1. get：「不可（…）」每个原因只列前 5 个 id + 「等 N 张」；--json 或 --all 给全量。其它长列表（可接手名单等）同规则处理。
2. 任何子命令见到 --help/-h（任何位置）只打印该子命令参数表，不发请求不写文件；未知子命令打印总 usage。questboard.js 头部注释同步补全（resolve --reopen、cancel --detail、card edit、brief dismiss、batch、--review、--supersedes、--hold、--needs、--origin、--check、--files）。
3. resolve --ack --reopen（或 --reopen 默认回 posted 且保留派单史）；--detail 与 --reason 两个都收（resolve/cancel 都收）。
4. release：进程树验证为空时直接可用，不再要求先 cancel；验证不为空仍拒绝并说明。
5. status：同时收位置参数和 --status；值不合法时报错带 usage 示例。
6. card add/edit --env KEY=VALUE（可重复，env 值非机密校验同 roster.js）；新增 card edit <id> [--name] [--model] [--variant] [--note] [--env K=V]（写名册前全量校验，先备份名册文件——roster 保存已有备份逻辑，复用）。
7. update <id> --review-page <path>（沿用现有 metadata 校验）。
8. 兼容旧写法：resolve/cancel 的 --detail 与 --reason 等价（内部归一），文档与报错信息一致。

**Verify:** node --test test/cli/cli.test.js test/cli/quest-detail.test.js test/cli/acceptance.test.js、npm test

---

## FB2-07 名册真实性（条目 9, 10.顺带, 33/34 计费字段）

**Files:**
- Modify: src/core/roster.js（新字段：billing、coordinatorAssignable、concurrencyGroup、groupMaxParallel、capabilities、verified）、src/core/rosterImport.js（opencode 能力过滤）、src/lanes/opencode.js（410/404 → broke 证据，与 FB2-01.2 合流）、src/cli/commands.js（roster import 过滤开关）、web 名册视图
- Test: test/core/roster.test.js、test/core/rosterImport.test.js（新文件）、test/cli/roster-import.test.js

**验收：**
1. 名册卡新增字段（全部可选、有校验）：billing: 'free'|'monthly'|'metered'（缺省 'metered'）、coordinatorAssignable: bool（仅 billing:free 可设 true，否则校验拒绝）、concurrencyGroup: string、groupMaxParallel: 正整数、capabilities: string[]、verified: 'unverified'|'ok'|'broken'。
2. opencode models --verbose 导入过滤：只留输入输出都是 text 且支持工具调用的（解析 verbose 字段；解析不到能力字段时保留但标 unverified，不静默丢弃）；EOL/下线的（410/404）标 broken。roster import 对 opencode 源默认开启过滤，--no-filter 关闭。
3. 采集到 410/404/model-not-found 交付证据 → 卡自动 broke 并带原文（与 FB2-01.2 共用响应路径，两边不重复实现）。
4. 卡 broke→available 后历史保留（status.js 本来就是追加记录；补一个拖卡时提示「上次 broke：原因（时间）」的 rules/UI 输出）。
5. 名册 UI：unverified 徽标；拖卡选择器里批量导入且从未成功交付的卡默认折叠，可展开。

**Verify:** node --test test/core/roster.test.js test/core/rosterImport.test.js test/cli/roster-import.test.js、npm test、cd web && npx vitest run

---

## FB2-08 货架（条目 3, 16）

**Files:**
- Modify: src/core/briefs.js（dismissed 存储与过滤、逐文件计数、同编号标注）、src/server/questRoutes.js 或 src/server/boardRoutes.js（dismiss/undo API、excluded ?all=1）、src/cli/commands.js（brief dismiss）、web/src/components/BriefShelf.tsx
- Test: test/core/briefDiscovery.test.js（现有）、test/cli/acceptance.test.js

**验收：**
1. 货架每行一个「已在板外完成/忽略」按钮 → 写 dismissed 记录（jsonl：{at, package, brief, by, note}，存 dataDir，不进 events 事件名空间）；discoverBriefs 过滤掉被 dismissed 的文件；CLI questboard brief dismiss <package> [--note ...]；「撤销」入口（API + CLI brief undismiss <package>）。dismissed 记录随快照进 briefDiscovery，UI 显示可撤销列表。
2. 同编号多份 brief：每个物理文件单独计数、单独列出，行上标「与 <主副本> 同编号」；归档（dismiss）任何一份都立刻反映在计数里。
3. excluded 接口支持 ?all=1 返回全部（去掉 MAX_EXCLUDED 截断），默认仍截断。
4. 「为什么还有 N 个文件没出现」的口径说明：页面小字解释 excludedTotal 包含重复/坏文件名/不可读/已 dismiss 等类别（用 byKind 数据渲染）。

**Verify:** node --test test/core/briefDiscovery.test.js test/cli/acceptance.test.js、npm test、cd web && npx vitest run

---

## FB2-09 UI 排版（条目 11, 15）

**Files:**
- Modify: web/src/styles/report-evidence.css（acceptance-panel 三列固定）、web/src/components/BriefShelf.tsx + 共享 checkbox 样式
- Test: web/src/components/quest/EvidenceSection.test.tsx、web/src/components/BriefShelf.test.tsx

**做法：**
1. 先复现：起一个临时项目（或 6098 测试项目），用 ego 浏览器截图确认现状（两个页面），修复后同角度截图对比。验收证据 = 前后截图 + 测试。
2. 验收面板每行固定三列：复选框（固定宽，左）｜标签（white-space: nowrap）｜说明（可换行、灰小字、占剩余宽度）；不可选行整行置灰；窄窗口说明落到标签下一行而不是截断。CSS 用 grid 三列（grid-template-columns: auto auto 1fr）。
3. BriefShelf 两个「也显示…」开关：label 包住 input + span 文字，同行垂直居中，焦点框只包控件；全站搜一遍裸 checkbox 放进 label 里（验收面板同一修法）。
4. 167/137 口径说明（条目 15 顺带）在 FB2-08.4 落，本任务只排布局。

**Verify:** cd web && npx vitest run、浏览器截图对比（zh-CN）

---

## FB2-10 卡面信息（条目 14, 32, 17.3）

**Files:**
- Modify: src/lanes/opencode.js（sessionState：无 assistant 消息且 elapsed > stallAfterMinutes → stalled「会话无响应」；lastActivityMs 曝光；token 汇总）、src/server/dispatcher.js（交付时把 token 用量记进派单史）、src/core/snapshot.js（卡面 live 数据透出）、web/src/components/QuestDrawer.tsx / QuestCard.tsx（「上次有动静」「本次 token」「系统提示异常大」）、stalled 卡启动日志入口
- Test: test/lanes/opencode.test.js、test/server/dispatcher*.test.js

**验收：**
1. opencode 会话：没有 assistant 消息、距最后一条消息（含 user 消息的时间）超过 policy.stallAfterMinutes → state='stalled'，reason「会话无响应：最后一条消息 x 分钟前」；恢复活动后回到正常状态（非终态，可自愈）。
2. 卡面显示「上次有动静：x 分钟前」（来自 live.lastActivityMs；文件通道用 .out mtime，API 通道用消息时间）。
3. token 明细：opencode 交付时读 /session/<id>/message，记派单史 usage: { messages, firstInputTokens, inputTokens, outputTokens, cacheTokens }；卡面显示「本次 N 条消息 · 输入 X · 缓存命中 Y」；firstInputTokens > 50000 标红「系统提示异常大」；读不到就显示「用量未知」，不编造。
4. stalled 卡片给「查看启动日志」入口：API 返回 dispatch 步骤 log 的最近 100 行（限制行数，防大文件），卡面按钮打开。

**Verify:** node --test test/lanes/opencode.test.js、npm test、cd web && npx vitest run

---

## FB2-11 评审页与 art 交付（条目 12, 13）

**Files:**
- Modify: src/core/snapshot.js（reviewPages 过滤）、src/server/dispatcher.js（art 交付后自动 reviewPage/needs_owner）、web/src/components/QuestDrawer.tsx（打开评审页按钮）
- Test: test/core/snapshotReviewPages.test.js（新文件）、test/server/dispatcherDelivery.test.js

**验收：**
1. reviewPages 只认评审目录第一层、且同目录有 manifest.json 的 html；忽略 src/、before/ 等子目录（实现成「只扫描 depth=1，目录内存在 manifest.json 才列出该目录下的匹配 html」）。
2. art 卡交付且产出目录有 manifest.json + 评审页 → 自动填 quest.reviewPage 并转 needs_owner，detail「评审页已生成，等 owner 评审」；找不到就不动状态。
3. reviewPage 非空时卡面给「打开评审页」按钮。
4. update --review-page 走 metadataUpdate 白名单（CLI 参数在 FB2-06.7 做，本任务只做服务端字段落库与 UI）。

**Verify:** node --test test/core/snapshotReviewPages.test.js test/server/dispatcherDelivery.test.js、npm test、cd web && npx vitest run

---

## FB2-12 并发组与 coordinator 快速通道（条目 33, 34）

**Files:**
- Modify: src/core/rules.js（组并发、coordinator assign 放行）、src/server/questRoutes.js + src/server/dispatcher.js（assign 门禁、origin 展示）、src/cli/commands.js（post --origin/--check）、src/core/store.js（quest.origin/check 字段）、src/core/roster.js（FB2-07 的字段在本任务消费）、web 卡面
- Test: test/core/rules.test.js、test/server/quest-detail.test.js、test/cli/assign-default-card.test.js

**验收：**
1. 同 concurrencyGroup 的卡共享并发上限（组内所有卡的 groupMaxParallel 必须一致，roster 校验冲突就拒绝加载）；组满时拖卡拒绝并显示「同组的 X 正在跑」，任务排队而不是硬挤（组满的判定用当前 dispatched 的组内卡）。
2. post --origin machine-check --check "unity recompile"：任务带 origin/check；派单史和卡面显示「coordinator 快速通道：<检查名>」。
3. coordinator 身份 assign：仅当卡 coordinatorAssignable === true 且任务 origin 为 machine-check/post-delivery-check 且可改文件数 ≤ 3（--max-files 默认 3）时放行；其余拒绝并说明原因（owner 不受此限）。
4. 与 FB2-05 配套：postDeliveryCheck 最终失败且回弹也失败 → 自动 post 一张小修复卡（origin=post-delivery-check，check=那条命令，files 取原 brief 的可改文件，≤3 才生成，>3 只发收件箱提醒），不自动 assign。

**Verify:** node --test test/core/rules.test.js test/server/quest-detail.test.js、npm test

---

## FB2-13 worktree + patch 交付（条目 29，最后做）

**Files:**
- Modify: src/core/config.js（policy.worktrees: { enabled: true, dir: '.qb-worktrees' }，默认关闭——按项目开启）、src/server/dispatcher.js + src/core/dispatch.js（派单前 worktree add、cwd 改副本、交付时 diff）、src/lanes/collector.js（副本内产物路径）、src/core/deliveries.js（patch 与改动清单）、src/cli/commands.js（questboard integrate <id>）、web 卡面（patch/改动清单/越界标红）
- Test: test/server/dispatcherWorktree.test.js（新文件，用真 git 仓库 fixture）、test/cli/*

**做法（先写设计再动手，本任务单独一轮评审）：**
1. 派单时若开启且项目是 git 仓库：git worktree add --detach <dir>/<worker-name> <base>（base 默认 HEAD，--base 可选）；worker 只在副本里改（wrapper 的 cwd/env 指过去）；交付 = 副本相对 base 的 git diff → patch 文件 + 改动清单，自动与 brief 可改文件对比，越界标红。
2. questboard integrate <id>：coordinator 验收后把 patch 应用到主工作树（或直接拷贝文件清单并保留冲突提示），删除副本；事件 integrate 记录。
3. art 卡同理：每次重做天然落新副本，不再覆盖（18.3 的结构性解法）。
4. 关闭时行为与现在完全一致（默认不开启，全部回归测试必须保持绿）。
5. 这个任务允许拆 2-3 个小任务提交，但完成定义是上面 4 条 + 真实 git fixture 的端到端测试。

**Verify:** node --test test/server/dispatcherWorktree.test.js、npm test

---

## 复核任务

- **FB2-R1（A 批）**：逐条核对 FB2-01..05 的验收清单，跑各自 Verify 命令 + npm test；检查 traps（Windows 'a' 追加句柄、\r 处理、ESM type、无 AI 署名、中文文案、拒绝带原因）；发现项用 findings 报告（id/severity/problem/requiredFix）。
- **FB2-R2（B+C 批）**：FB2-06..11 同上；web 改动要跑 vitest + 起浏览器截图核对（FB2-09 尤其）。
- **FB2-R3（D 批）**：FB2-12..13 同上。

---

## 验证矩阵（每条的最终证据）

| 条目 | 落点 | 测试/证据 |
|:--|:--|:--|
| 1 | CLI get 截断 | test/cli/quest-detail.test.js |
| 2 | CLI --help | test/cli/cli.test.js |
| 3 | 货架 dismissed | test/core/briefDiscovery.test.js + CLI |
| 4 | supersedes | test/core/store.test.js + rules |
| 5 | 死亡识别 401 | test/lanes/collector.test.js + dispatcher |
| 6 | resolve --reopen / release | test/cli/acceptance.test.js |
| 7 | status 用法 | test/cli/cli.test.js |
| 8 | card add/edit --env | test/cli/roster-init.test.js 附近 |
| 9 | 名册过滤/未验证 | test/core/rosterImport.test.js |
| 10 | agy 即败识别 + broke 历史 | 同 5 |
| 11 | 验收面板排版 | vitest + 前后截图 |
| 12 | 评审页过滤 | test/core/snapshotReviewPages.test.js |
| 13 | art 自动 reviewPage | test/server/dispatcherDelivery.test.js |
| 14 | 会话无响应 stalled | test/lanes/opencode.test.js |
| 15 | 货架开关排版 | vitest + 截图 |
| 16 | 逐文件计数/?all | test/core/briefDiscovery.test.js |
| 17 | brief 文件名校验 + 启动即败 + 日志入口 | test/server/quest-detail.test.js、collector、UI |
| 18 | 批注进派单材料/needs_coordinator/备份 | test/server/dispatcherAnnotation.test.js |
| 19 | hold/父卡 done | test/core/rules.test.js |
| 20 | 同 18 + 保存报错 | 同 18 |
| 21 | VERDICT/收件箱/核验区排序 | collector + board + web |
| 22 | --detail 别名 + 孤儿进程 | CLI 测试 + wrapper/jobObject 注释验证 |
| 23 | claude result → delivered | test/lanes/protocols.test.js |
| 24 | git 快照/越界排除 | test/server/dispatcherDelivery.test.js |
| 25 | batch/waiting-on | store + CLI + web |
| 26 | owner_ruled/收件箱 | store + boardRoutes |
| 27 | postDeliveryCheck | test/server/dispatcherPostDeliveryCheck.test.js |
| 28 | review none|mechanical|model | 同 27 |
| 29 | worktree/patch | test/server/dispatcherWorktree.test.js |
| 30 | files 只从可改文件节抽 + --files | derive/briefDiscovery 测试 + post 回显 |
| 31 | 能力标签/probes | test/core/rules.test.js + test/cli/doctor.test.js |
| 32 | token 明细 | test/lanes/opencode.test.js |
| 33 | 快速通道 | test/core/rules.test.js |
| 34 | 计费/coordinatorAssignable/并发组/自动修卡 | rules + roster + dispatcher |

---

## 风险与依赖

1. **写手可用性**：agent-teams 成员继承 captain 模型；任务按 2-5 分钟一步切小，避免超时半成品。
2. **6097 生产看板**：任何服务端改动合并后按协议重启并 curl 确认；Wastecape 的 tools/*-run.sh 属于项目仓库，不在本仓库改，本仓库只保证「看板侧识别」兜底。
3. **UI 两条（11/15）必须实机复现**：先截图复现再改，避免「改了个没坏的」。
4. **FB2-13 是大改造**：放在最后，默认关闭，不碰旧路径；单独设计小节 + 单独复核。
5. **第一册 41 条已合并**：本册改动不得回归第一册行为；npm test 全程用例是回归底线。
