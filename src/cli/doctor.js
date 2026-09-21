// Doctor command: checks node version, project configuration, lane scripts,
// roster, status log, review pages, usage keys, and running board server.
import nodeFs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { bashPath } from '../core/dispatch.js';
import { DEFAULT_PORT } from '../core/config.js';
import { homePaths, questboardHome } from '../core/home.js';
import { loadRoster, loadRosterOrEmpty, saveRoster } from '../core/roster.js';
import { createCredentials } from '../usage/credentials.js';
import { PROVIDERS } from '../usage/providers.js';

const timeout = (ms) => new Promise((_, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), ms);
  t.unref?.();
});

function getLaneScript(cmd) {
  if (!Array.isArray(cmd) || !cmd.length || typeof cmd[0] !== 'string') return null;
  if (cmd[0].endsWith('.sh')) return cmd[0];
  if (cmd[0] === 'node') return cmd[1] || null;
  return null;
}

export async function runDoctor({
  config,
  home,
  env = process.env,
  homedir,
  fetchImpl = fetch,
  probeRunner = defaultProbeRunner,
  fs = nodeFs,
  platform = process.platform,
}) {
  const checks = [];
  const resolvedHome = homedir || (env.QUESTBOARD_HOME ? path.resolve(env.QUESTBOARD_HOME) : os.homedir());
  const homeObj = typeof home === 'string' ? homePaths(home) : (home || homePaths(questboardHome(env)));

  // 1. Node.js version >= 22
  const v = process.versions.node;
  const major = parseInt(v.split('.')[0], 10);
  checks.push({ name: 'Node.js 版本', ok: major >= 22, detail: major >= 22 ? `v${v}` : `当前 v${v}，需要 >= 22` });

  // 2. Project config
  try {
    if (!config?.name || !config?.port || !config?.paths) {
      checks.push({ name: '项目配置', ok: false, detail: '配置缺少 name、port 或 paths' });
    } else {
      fs.mkdirSync(config.paths.data, { recursive: true });
      fs.mkdirSync(path.dirname(config.paths.events), { recursive: true });
      fs.mkdirSync(path.dirname(config.paths.registry), { recursive: true });
      checks.push({ name: '项目配置', ok: true, detail: `${config.name}（端口 ${config.port}，数据目录正常）` });
    }
  } catch (err) {
    checks.push({ name: '项目配置', ok: false, detail: `数据目录不可写：${err.message}` });
  }

  // 3. Git Bash on Windows when any lane template ends with .sh
  const laneEntries = config?.lanes ? Object.entries(config.lanes) : [];
  const hasSh = laneEntries.some(([, l]) => (l.run || []).concat(l.session?.run || []).some((a) => typeof a === 'string' && a.endsWith('.sh')));
  if (platform === 'win32' && hasSh) {
    try {
      checks.push({ name: 'Git Bash', ok: true, detail: bashPath(config, env) });
    } catch (err) {
      checks.push({ name: 'Git Bash', ok: false, detail: err.message });
    }
  }

  // 4. Each lane: script, session script, outputDir, api
  for (const [id, lane] of laneEntries) {
    const checkScript = (cmd, label) => {
      const script = getLaneScript(cmd);
      if (!script) {
        checks.push({ name: label, ok: true, detail: '系统命令，未检查' });
      } else {
        const exists = fs.existsSync(path.resolve(config.root, script));
        checks.push({ name: label, ok: exists, detail: exists ? script : `缺少脚本 ${script}` });
      }
    };
    checkScript(lane.run, `通道 ${id} 脚本`);
    if (lane.session?.run) checkScript(lane.session.run, `通道 ${id} 会话脚本`);

    if (lane.outputDir) {
      try {
        fs.mkdirSync(path.resolve(config.root, lane.outputDir), { recursive: true });
        checks.push({ name: `通道 ${id} 输出目录`, ok: true, detail: lane.outputDir });
      } catch (err) {
        checks.push({ name: `通道 ${id} 输出目录`, ok: false, detail: `输出目录不可用：${err.message}` });
      }
    }

    if (lane.api) {
      try {
        const res = await Promise.race([fetchImpl(lane.api), timeout(3000)]);
        checks.push({ name: `通道 ${id} API`, ok: true, detail: `可连接（HTTP ${res?.status ?? 'OK'}）` });
      } catch (err) {
        checks.push({ name: `通道 ${id} API`, ok: false, detail: `无法连接（${err.message || 'unreachable'}）` });
      }
    }
  }

  // 5. Roster
  try {
    const roster = loadRoster(homeObj.roster);
    const cards = roster?.adventurers || [];
    const definedLanes = config?.lanes || {};
    const unknownLanes = [...new Set(cards.map((c) => c.lane).filter((lane) => !definedLanes[lane]))];
    checks.push({
      name: '冒险者名册',
      ok: unknownLanes.length === 0,
      detail: unknownLanes.length ? `${cards.length} 张卡，警告：引用了项目没配置的通道${unknownLanes.join(', ')}` : `${cards.length} 张卡全部可用`,
    });
  } catch (err) {
    const missing = !fs.existsSync(homeObj.roster);
    checks.push({
      name: '冒险者名册',
      ok: false,
      detail: missing
        ? `还没有名册（${homeObj.roster}）：跑 questboard roster init 建一个空的，再到看板「冒险者」页加卡`
        : `名册无法加载（${homeObj.roster}）：${err.message}`,
    });
  }

  // 6. Status log
  if (!fs.existsSync(homeObj.status)) {
    checks.push({ name: '状态记录', ok: true, detail: '还没有状态记录' });
  } else {
    try {
      const lines = fs.readFileSync(homeObj.status, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
      lines.forEach((l) => JSON.parse(l));
      checks.push({ name: '状态记录', ok: true, detail: `${lines.length} 条记录` });
    } catch (err) {
      checks.push({ name: '状态记录', ok: false, detail: `状态文件格式错误：${err.message}` });
    }
  }

  // 7. Review pages dir
  if (config?.reviewPages?.dir) {
    const exists = fs.existsSync(config.reviewPages.dir);
    checks.push({ name: '评审页面目录', ok: exists, detail: exists ? config.reviewPages.dir : `目录不存在：${config.reviewPages.dir}` });
  }

  // 8. Usage keys (never leak values; booleans only)
  try {
    const creds = createCredentials({ env, homedir: resolvedHome });
    const summaries = [];
    for (const p of PROVIDERS) {
      if (!p.keys && !p.oauth) continue;
      const items = creds.presence({ envNames: p.keys?.envNames, openCodeIds: p.keys?.openCodeIds, oauthIds: p.oauth?.openCodeIds });
      const present = items.filter((i) => i.present).map((i) => i.name);
      summaries.push(`${p.name}：${present.length ? present.join(' / ') : '未配置'}`);
    }
    checks.push({ name: '用量密钥', ok: true, detail: summaries.join('；') });
  } catch (err) {
    checks.push({ name: '用量密钥', ok: false, detail: err.message });
  }

  // 9. Board server
  const port = config?.port || DEFAULT_PORT;
  try {
    const res = await Promise.race([fetchImpl(`http://127.0.0.1:${port}/api/health`), timeout(2000)]);
    let body = res;
    if (typeof res?.json === 'function') {
      try { body = await res.json(); } catch { body = res; }
    }
    if (body?.ok === true) {
      if (body.project === config.name) {
        checks.push({ name: '看板服务', ok: true, detail: `看板在跑（${body.project}）` });
      } else {
        checks.push({ name: '看板服务', ok: false, detail: '端口被别的项目占用' });
      }
    } else {
      checks.push({ name: '看板服务', ok: false, detail: '看板服务响应异常' });
    }
  } catch {
    checks.push({ name: '看板服务', ok: true, detail: '没在跑（questboard serve 可以启动）' });
  }


  // 10. FB2-03 item 5: lane probes measure what this machine can actually run. The measured set per lane
  // is written into the machine roster as those cards' capabilities — facts about the machine, no status,
  // no dates. A lane without probes leaves its cards' capabilities untouched.
  const probeLanes = laneEntries.filter(([, lane]) => lane.probes && Object.keys(lane.probes).length);
  if (probeLanes.length) {
    const measured = {};
    const failures = [];
    for (const [id, lane] of probeLanes) {
      const caps = [];
      for (const [name, argv] of Object.entries(lane.probes)) {
        let result;
        try {
          result = await probeRunner(argv, { config, env });
        } catch (err) {
          result = { ok: false, detail: err.message || 'probe failed' };
        }
        if (result.ok) caps.push(name);
        else failures.push(`${id}.${name}：${result.detail}`);
      }
      measured[id] = caps.sort();
    }
    try {
      const roster = loadRosterOrEmpty(homeObj.roster);
      let touched = 0;
      const adventurers = (roster.adventurers || []).map((card) => {
        if (!(card.lane in measured)) return card;
        const caps = measured[card.lane];
        if (JSON.stringify(card.capabilities || []) === JSON.stringify(caps)) return card;
        touched += 1;
        return { ...card, capabilities: caps };
      });
      if (touched) saveRoster(homeObj.roster, { ...roster, adventurers }, { lenientEnv: true });
      const perCard = adventurers
        .filter((card) => card.lane in measured)
        .map((card) => `${card.id}（${(card.capabilities || []).join('、') || '什么都没测出来'}）`);
      checks.push({
        name: '能力探针',
        ok: failures.length === 0,
        detail: (perCard.join('；') || '没有卡在有探针的通道上') + (failures.length ? `；没测过：${failures.join('、')}` : ''),
      });
    } catch (err) {
      checks.push({ name: '能力探针', ok: false, detail: `名册写不进去：${err.message}` });
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}


// FB2-03 item 5: a probe is one argv list run through Git Bash (never joined and re-split naively —
// each argument is shell-quoted first), 10s budget, exit 0 means the machine really has the capability.
const PROBE_TIMEOUT_MS = 10000;

function shellQuote(arg) {
  return "'" + String(arg).replaceAll("'", "'\\''") + "'";
}

export async function defaultProbeRunner(argv, { config, env = process.env } = {}) {
  const bash = bashPath(config || {}, env);
  const command = argv.map(shellQuote).join(' ');
  return new Promise((resolve) => {
    execFile(bash, ['-lc', command], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (!error) resolve({ ok: true, detail: String(stdout || '').trim().split('\n')[0].slice(0, 80) || 'exit 0' });
      else if (error.killed || error.signal === 'SIGTERM') resolve({ ok: false, detail: `超时（${PROBE_TIMEOUT_MS / 1000}s 没跑完）` });
      else resolve({ ok: false, detail: `exit ${error.code ?? '?'}` });
    });
  });
}
