# questboard

本机的「悬赏板」，用来把编码任务派给各家 AI 编程 CLI。

（English: [README.md](README.md)）

你写一份任务简报（brief），它就变成板上的一个**委托**。你能用的每个模型——不管是通过 Codex CLI、Claude
Code、OpenCode、Google 的 agy，还是你自己写的脚本——都是一张**冒险者卡**。把卡拖到委托上，questboard
就在后台跑那条通道的命令。**放手之前，它就告诉你这张卡能不能接、为什么不能**：

- 这个模型限额了、没余额了、或者被你暂停了（连什么时候起、为什么都写在卡上）；
- 这个项目不允许该通道接这个委托；
- 这张卡手上的并发数已经满了；
- 审核委托派给了写过这段代码的同一个模型家族（跨供应商、沿整条父任务链检查）；
- 另一个正在跑的委托要改同一批文件（从各自简报的「Files you may edit」读出来）——显示为排队，一次一个；
- 验证锁还在、简报文件不存在、或者还有一个等你裁决的问题没答。

coordinator（一个 AI 助手会话）可以发布委托、接管它自己手工启动的 worker、并跟踪一个 NDJSON 事件文件。
worker 的结果会自动变成委托状态，限额到点会自己恢复。

状态：已在一个真实项目上日常使用。核心、HTTP 服务器、CLI、MCP 服务器、React 看板（委托墙、关系图、留言板、
美术评审、派遣记录、名册与模型配置、用量、设置）和 Tauri 桌面应用都已完成并有测试。

## 要求

- Node 22 或更新。看板本身没有运行时依赖。
- Windows 上，如果通道脚本是 `.sh`，需要 Git Bash（那里的 `bash` 常常是 WSL，跑不了）。装在非标准位置的话，
  在项目配置里写 `"bash"`，或设环境变量 `QUESTBOARD_BASH`。

## 快速开始

```bash
git clone https://github.com/zhehaosun717/questboard && cd questboard && npm install -g . && npm run setup
```

`npm install -g .` 让你能直接敲 `questboard` 命令；`npm run setup` 编译看板界面（`web/dist`），不编译的话
服务器会退回到一个单文件的旧版页面。

然后给你自己的项目做初始化——一条命令就写好配置、worker 包装脚本、一份示例委托和本机名册，并且**按你这台
机器上装了哪些 agent CLI** 来配置通道：

```bash
questboard init ~/my-game
```

加第一张卡（一个你确实能跑的模型），然后启动看板：

```bash
questboard card add --id my-codex --name Codex --provider OpenAI --lane codex --model gpt-5.6-luna --variant high
```

```bash
questboard serve --project ~/my-game
```

打开 `http://127.0.0.1:6097/`，发布那份示例委托，把卡拖上去：

```bash
questboard post --package RUN-1 --brief docs/briefs/RUN-1-first-task.md --project ~/my-game
```

哪里不对劲就跑体检，它会逐项告诉你缺什么：

```bash
questboard doctor --project ~/my-game
```

### 用你自己的工具

一条通道（lane）本质就是一条命令，所以把你用的工具直接告诉 `init`，可以重复写多个：

```bash
questboard init ~/my-game --lane aider="aider --model {model} --yes" --lane mytool="python tools/agent.py"
```

简报会从这条命令的**标准输入**喂进去，`{model}` `{variant}` `{name}` `{package}` 会被自动替换。

不写 `--lane` 时，`init` 只为它**确认过怎么驱动**、并且在这台机器上装了的 CLI 写通道
（`codex exec -m <模型>`、`claude --print --model <模型>`），同时把它发现的其它 CLI（OpenCode、agy、Gemini、
cursor-agent）报给你，让你用 `--lane` 自己加。

写之前先看一眼你那个 CLI 的 `--help`：如果它要求把提示词作为**参数**传、或者需要先建会话，那就得在 `run`
里放一个你自己的小脚本，见下面「项目配置」。

### 不想碰终端

`desktop/` 能编译出一个 Windows 安装包，里面打包了服务器、界面和初始化命令，所以那台机器上只需要装 Node 22。
装完双击，选一个文件夹——**即使它还不是一个项目**，应用会问你要不要就地建一个，点「在这里建」就配好并直接
打开看板，全程不用敲命令。

## 三种数据，分开存放

| 存在哪 | 存什么 | 谁共用 |
|:---|:---|:---|
| `~/.questboard/roster.json`（或 `QUESTBOARD_HOME`） | 卡：id、名字、供应商、通道、模型、家族、变体、人格、计费方式、并发上限、专长、通用备注 | 这台机器上的所有项目 |
| `~/.questboard/status.jsonl` | 状态记录：`{at, adventurerId, status, reason, setBy}`。没有记录的卡就是可用 | 所有项目 |
| `<项目>/questboard.config.json` | 简报目录和编号规则、通道命令、输出目录、事件/登记/锁文件路径、禁用模型 | 单个项目 |

带日期的决定（「9 月 12 日暂停，太费钱」）永远是**状态记录**，不是名册里的文字——这样名册才能复用。

## 项目配置

见 [`examples/basic/questboard.config.json`](examples/basic/questboard.config.json)。一条通道 = 一个命令模板，
加上它的 worker 在哪能被观察到：

```json
"codex": {
  "run": ["node", "scripts/run-worker.mjs", "--lane", "codex", "--name", "{name}", "--brief", "{brief}",
          "--model", "{model}", "--variant", "{variant}", "--package", "{package}",
          "--", "codex", "exec", "-m", "{model}"],
  "outputDir": ".questboard-data/workers/codex"
}
```

占位符：`{name}`（唯一的 worker 名）、`{brief}`、`{model}`、`{variant}`、`{agent}`、`{package}`。
**占位符没有值就是错误，不会变成空字符串。** `.sh` 命令用 Git Bash 跑，`node` 用当前的 Node 跑。

文件型通道在运行时写 `<outputDir>/<name>.out`，结束时写 `<name>.exit`，可选地写 `<name>.md` 作为报告。
服务器型通道（OpenCode 那种）要配 `api`、一个 `session` 步骤和 `deliveryDir`；它的最后一条消息会先写进
`<deliveryDir>/<name>.md`，然后才宣布「已交付」。`serialize` 表示一次只跑一个，`spacingMs` 控制启动间隔，
`defaultModel` 用来标注旧的登记记录。

`examples/basic/scripts/run-worker.mjs` 是一个零依赖的通用包装脚本：它先往登记表写一行，再把简报喂给你的
agent 命令，最后写下退出码。`init` 会把它拷到你的项目里。

## CLI

```text
questboard init [<目录>] [--name "My Game"] [--port 6097] [--lane 名字="命令"] [--force]
questboard serve [--project <目录>] [--port <n>]
questboard post --package RUN-4 --brief docs/briefs/RUN-4-x.md [--kind code|review|art|tool|owner]
     [--parents A-1] [--conflicts B-2] [--lanes codex,agy] [--priority 1|2|3] [--needs-owner "问题"]
questboard list | status <id> <状态> | ruling <id> --text ... | assign <id> --adventurer <卡>
questboard adopt <id> --adventurer <卡> --name <worker 名>
questboard card list | card add --id x --name X --provider P --lane codex --model m
questboard card status <卡> <available|limited|broke|paused|disabled> --reason "..."
questboard roster init | roster path | roster import <旧 roster.json> [--dry-run | --force | --replace --force]
questboard board post|reply|list|read|close|inbox
questboard watch [--from-start]
questboard doctor
```

`roster import` 按卡 id 合并：本机改过的每卡 `env`、variant 和文件里没有的卡都会保留（只覆盖文件里明确
给出的值，`env` 按 key 合并），全部内容先校验通过才落盘，旧 roster 会先备份，备份名带一个防撞的计数后缀
`roster.json.bak-<时间>-<n>-merge`（同一秒内两次导入也各留一份，不会互相覆盖）。`--dry-run` 只打印计划
（计数和改动的字段名，绝不打印值，也绝不打印 env 的 key 名或备注原文）。状态记录只单向新增：**导入只会给
一张从没有过状态记录的卡写第一条记录。** 只要卡已经有任何状态历史——哪怕是显式的 `available`——导入就不会
碰它，不管导入的记录看起来多新、文件的修改时间多新；这里没有「强制覆盖」的开关，就是设计成这样。旧文件里
没写单卡日期时，第一次导入仍然会把这张卡的初始状态记下来（不然它就无缘无故一直显示「可用」），但记录会
老实写明这个时间是导入自己猜的，不是 owner 真的在那一刻做了决定。`--replace --force` 才是明确的整体替换
（同样先备份）；单独的 `--force` 只是确认合并，不会删卡。解析不了的文件只按位置报错，不会把文件内容念回来。

## MCP

`questboard mcp` 是一个走 stdio 的 MCP 服务器，任何 agent 都能把看板当工具用，不必敲命令行。14 个工具：
`questboard_list_quests`、`questboard_get_quest`（含谁能接、为什么不能）、`questboard_post_quest`、
`questboard_set_quest_status`、`questboard_record_ruling`、`questboard_assign`、`questboard_adopt`、
`questboard_release_worker`、`questboard_list_cards`、`questboard_set_card_status`、`questboard_events`、
`questboard_board_post`、`questboard_board_reply`、`questboard_board_inbox`。

写操作都经过正在跑的看板服务器，所以先 `questboard serve`。

Claude Code：

```text
claude mcp add questboard -- node /路径/questboard/src/cli/questboard.js mcp --project /路径/game --author coordinator
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.questboard]
command = "node"
args = ["/路径/questboard/src/cli/questboard.js", "mcp", "--project", "/路径/game", "--author", "coordinator"]
```

## 事件

事件文件每次变化写一行：`{seq, at, event, package, lane, model, variant, name, by, detail}`。
事件名：`posted`、`review_posted`、`assigned`、`dispatched`、`delivered`、`failed`、`bounced`、`stalled`、
`released`、`cancelled`、`owner_ruling`、`delivery_write_failed`、`status_<状态>`。

**「卡住」不等于「结束」。** 一个 `stalled` 的委托仍然占着它的 worker：没动静不代表进程死了，所以它的并发
名额和文件占用都还保留，谁都派不上去。输出恢复就自动回到 `dispatched`；出现退出文件就正常收尾。等有人确认
进程真的没了，用 `POST /api/quests/<id>/release`（或 MCP 的 `questboard_release_worker`，或档案抽屉里的按钮）
释放，记一条 `released` 事件。

每条事件都有 `seq`。`GET /api/events?after=<seq>&limit=<n>` 按顺序往后读，所以记住最后处理的 `seq` 就一条
都不会漏——按时间轮询则可能漏掉同一秒内写的两条。旧版看板写的、没有 `seq` 的行，会按位置编号。

每个委托都有 `revision`，每次变化 +1。`assign` 和 `adopt` 接受 `ifRevision`：如果委托在你读取之后被改过，
就拒绝并返回 `stale_revision`，而不是派到一个你没看过的委托上。它们还接受你自己编的 `requestKey`：用同一个
key 重试会返回已有的那次派遣（`repeated: true`），绝不会起第二个 worker。

## 安全

服务器只绑 `127.0.0.1`。写操作必须是同源的 JSON、且发往本机主机名——否则你访问的任何网页都可能让你的浏览器
替你派遣**要花钱的** worker。评审页面用一条只允许保存批注的 CSP 提供。简报路径被限制在配置的目录里，因为
简报内容会被发给第三方模型。

用量面板读取各家的额度/余额时，key 只从环境变量或本机已有的登录信息里取，**只在内存里用一次，既不保存也不
返回给页面**；设置页只显示某个来源「有没有」，不显示值。

## 看板与桌面应用

看板页面是 `web/` 里的 React 应用（Vite，关系图用 React Flow + dagre）。服务器在 `/` 提供它的构建产物
（`web/dist`）；没有构建时提供旧版单文件页面，后者始终可在 `/classic` 访问。

```text
npm run setup                 # 在仓库根目录：安装并编译看板界面
cd web && npm run dev         # 对着正在跑的看板服务器开发（代理到 :6097）
```

`web/dist` 是构建产物，没有提交进仓库，所以刚 clone 下来时是旧版页面，跑一次 `npm run setup` 就好。

`desktop/` 是一个 Tauri 2 外壳：它找到或启动项目的看板服务器，然后用原生窗口显示看板；退出时只停它自己
启动的那个服务器。窗口加载的是服务器自己的页面，所以同源写入规则依然生效，页面也拿不到任何桌面权限。

```text
cd desktop && npm install
npm run dev          # 从这个 checkout 直接运行
npm run build        # 生成 Windows 安装包，会先编译 web/ 并把服务器打包进去
```

## 测试

```text
npm test
```

## 许可

MIT，见 [LICENSE](LICENSE)。
