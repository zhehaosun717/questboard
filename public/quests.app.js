'use strict';
// Quest board page. Served with script-src 'self'; every dynamic string goes through esc().
(() => {
  const COLUMNS = [
    { key: 'open', num: '01', title: '悬赏中', sub: 'OPEN', statuses: ['posted', 'failed', 'bounced', 'stalled', 'lane_limited'] },
    { key: 'run', num: '02', title: '进行中', sub: 'ON QUEST', statuses: ['dispatched'] },
    { key: 'check', num: '03', title: '待验收', sub: 'RETURNED', statuses: ['delivered', 'reviewing'] },
    { key: 'owner', num: '04', title: '等你', sub: 'YOUR CALL', statuses: ['needs_owner', 'owner_playtest'] },
    { key: 'done', num: '05', title: '已完成', sub: 'ARCHIVED', statuses: ['done', 'superseded', 'cancelled'], limit: 12 },
  ];
  const STATUS = { posted: '待接', dispatched: '进行中', delivered: '已交付', reviewing: '审核中', needs_owner: '等裁决', owner_playtest: '等你试玩', lane_limited: '通道受限', bounced: '限额退回', failed: '失败', stalled: '卡住', done: '已完成', superseded: '已取代', cancelled: '已取消' };
  const KIND = { code: '代码', review: '审核', art: '美术', tool: '工具', owner: '你来' };
  const ADV = { available: '空闲', limited: '限额', broke: '没钱', paused: '暂停', disabled: '停用' };
  const LED = { available: 'ok', limited: 'warn', broke: 'bad', paused: '', disabled: '' };
  const BILLING = { subscription: '订阅', plan: '套餐', payg: '按量付费' };
  const NODE_COLORS = { dispatched: '#4b86c9', delivered: '#9a7ccf', reviewing: '#9a7ccf', failed: '#d9442e', stalled: '#d9442e', bounced: '#e0662f', lane_limited: '#e0662f', needs_owner: '#f2b134', owner_playtest: '#f2b134', done: '#3fae6b' };

  const state = { snap: null, view: 'board', selected: null, picking: null, connected: false, refreshTimer: null, seen: new Set(), lastStatus: new Map() };
  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '');
  const ago = (ms) => (ms == null ? '' : ms < 60000 ? `${Math.round(ms / 1000)}秒` : ms < 3600000 ? `${Math.round(ms / 60000)}分` : `${(ms / 3600000).toFixed(1)}时`);
  const quest = (id) => state.snap.quests.find((q) => q.id === id);
  const adventurer = (id) => state.snap.roster.find((a) => a.id === id);
  const busy = (id) => state.snap.quests.filter((q) => q.status === 'dispatched' && q.assignee && q.assignee.adventurerId === id);
  const isDragging = () => document.body.classList.contains('dragging');

  async function api(path, method = 'GET', body) {
    const response = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(value.error || `HTTP ${response.status}`); error.reasons = value.reasons || []; throw error; }
    return value;
  }

  function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span class="t-time">${esc(new Date().toLocaleTimeString('zh-CN'))} · 公会回执</span>${esc(text)}`;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 6500);
  }

  // ── header chips ───────────────────────────────────────────────────────
  function chip(kind, html) { return `<span class="chip ${kind}"><i class="led"></i>${html}</span>`; }

  function renderChips() {
    const s = state.snap;
    if (s.project && s.project.name) {
      $('#projectName').textContent = `${s.project.name} · ADVENTURERS' GUILD`;
      document.title = `${s.project.name} 悬赏板`;
    }
    const chips = [chip(state.connected ? 'ok' : 'bad', state.connected ? '实时连接' : '重连中…')];
    if (s.env.treeLocked) chips.push(chip('warn', '🔒 coordinator 正在验证，暂停派遣'));
    for (const [lane, limit] of Object.entries(s.laneLimits || {})) chips.push(chip('warn', `${esc(lane)} 限额中${limit.until ? `，${esc(limit.until)} 恢复` : ''}`));
    if (s.openQuestions) chips.push(`<a class="chip warn" href="/board" target="_blank" rel="noreferrer"><i class="led"></i>留言板待答 ${s.openQuestions}</a>`);
    const v = s.verification;
    if (v && v.steps && v.steps.length) {
      const failed = v.steps.filter((step) => (step.kind === 'exit' || step.kind === 'errorCS') && step.value !== '0');
      const counts = `${v.editXml ? ` · Edit ${v.editXml.passed}/${v.editXml.total}` : ''}${v.playXml ? ` · Play ${v.playXml.passed}/${v.playXml.total}` : ''}`;
      chips.push(chip(failed.length ? 'bad' : 'ok', `验证${failed.length ? `失败 ${failed.map((f) => esc(f.name)).join('、')}` : '通过'}${counts}`));
    }
    chips.push(chip('', `更新 ${clock(s.generatedAt)}`));
    $('#chips').innerHTML = chips.join('');
  }

  // ── board ──────────────────────────────────────────────────────────────
  function questCard(q, index) {
    const live = q.assignee ? state.snap.live[q.assignee.name] : null;
    const adv = q.assignee ? adventurer(q.assignee.adventurerId) : null;
    const threads = state.snap.threads[q.id] || [];
    const previous = state.lastStatus.get(q.id);
    const meta = [];
    if (q.parents && q.parents.length) meta.push(`↑ ${q.parents.map(esc).join(' ')}`);
    if (q.conflicts && q.conflicts.length) meta.push(`⚠ ${q.conflicts.map(esc).join(' ')}`);
    if (threads.length) meta.push(`💬 ${threads.length}`);
    if (q.dispatches && q.dispatches.length > 1) meta.push(`第 ${q.dispatches.length} 次`);
    const heat = 4 - (q.priority || 2);
    const detail = ['failed', 'bounced', 'stalled', 'delivered', 'lane_limited'].includes(q.status) && q.lastDetail ? `<div class="q-detail">${esc(q.lastDetail)}</div>` : '';
    return `<article class="quest k-${esc(q.kind)} s-${esc(q.status)}${state.seen.has(q.id) ? '' : ' enter'}" style="--i:${index}" data-quest="${esc(q.id)}" tabindex="0">
      <div class="tag">
        <div class="q-top"><span class="tape">${esc(KIND[q.kind] || q.kind)}</span><span class="pid">${esc(q.id)}</span>
          <span class="pips" title="优先级 ${esc(q.priority || 2)}">${[1, 2, 3].map((n) => `<i class="${n <= heat ? 'on' : ''}"></i>`).join('')}</span></div>
        <h3>${esc(q.title)}</h3>
        <span class="stamp${previous && previous !== q.status ? ' thunk' : ''}">${esc(STATUS[q.status] || q.status)}</span>
        ${detail}
        ${q.needsOwner ? `<div class="q-ask">❓ ${esc(q.needsOwner)}</div>` : ''}
        ${q.assignee ? `<div class="q-who"><i class="led ok${q.status === 'dispatched' ? ' run' : ''}"></i><span>${esc(adv ? adv.name : q.assignee.model)}</span>${live ? `<span class="mono">${ago(live.elapsed)} · ${live.edits || 0} 改动</span>` : ''}</div>` : ''}
        ${meta.length ? `<div class="q-meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>` : ''}
        <div class="q-refuse"></div>
      </div>
    </article>`;
  }

  function renderBoard() {
    const quests = state.snap.quests;
    let index = 0;
    $('#boardView').innerHTML = COLUMNS.map((col) => {
      const items = quests.filter((q) => col.statuses.includes(q.status))
        .sort((a, b) => (col.limit ? 0 : (a.priority || 2) - (b.priority || 2)) || b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, col.limit || Infinity);
      const body = items.length ? items.map((q) => questCard(q, index++)).join('')
        : `<div class="empty">${quests.length ? '— 空 —' : '暂无委托<code>node tools/board/quest.js post</code>'}</div>`;
      return `<section class="col c-${col.key}"><header class="col-head"><span class="col-num">${col.num}</span><div class="col-title"><h2>${col.title}</h2><span>${col.sub}</span></div><span class="count">${items.length}</span></header><div class="list">${body}</div></section>`;
    }).join('');
  }

  function renderGuild() {
    const order = { available: 0, limited: 1, broke: 2, paused: 3, disabled: 4 };
    const groups = new Map();
    for (const a of state.snap.roster) groups.set(a.provider, [...(groups.get(a.provider) || []), a]);
    const ranked = [...groups.entries()]
      .map(([provider, members]) => ({ provider, members: [...members].sort((a, b) => order[a.status] - order[b.status]) }))
      .sort((a, b) => order[a.members[0].status] - order[b.members[0].status]);
    $('#guild').innerHTML = ranked.map((group) => `<h4 class="guild-group">${esc(group.provider)}<span>${esc(group.members[0].lane)}</span></h4>${group.members.map(badge).join('')}`).join('');
  }

  function badge(a) {
      const working = busy(a.id);
      const max = a.maxParallel || 1;
      const full = a.status === 'available' && working.length >= max;
      const label = a.status !== 'available' ? ADV[a.status] : `${full ? '满员' : '空闲'} ${working.length}/${max}`;
      const led = a.status !== 'available' ? LED[a.status] : full ? 'full run' : working.length ? 'ok run' : 'ok';
      return `<article class="adv st-${esc(a.status)}${full ? ' full' : ''}" data-adv="${esc(a.id)}" draggable="${a.status === 'available' && !full}" tabindex="0">
        <i class="led ${led}"></i>
        <div class="a-top"><span class="a-name">${esc(a.name)}</span><span class="a-st">${esc(label)}</span></div>
        <div class="a-model">${esc(a.model)}${a.variant ? ` · ${esc(a.variant)}` : ''}</div>
        <div class="a-meta">${esc(a.provider)} · ${esc(a.lane)} · <span class="${a.billing === 'payg' ? 'pay' : ''}">${esc(BILLING[a.billing] || a.billing || '')}</span></div>
        ${working.length ? `<div class="a-work">${working.map((q) => `<span>${esc(q.id)}</span>`).join('')}</div>` : ''}
        ${a.derived ? `<div class="a-note derived">⟳ ${esc(a.derived.reason)}（自动判断，限额过去后自动恢复）</div>` : ''}
        ${a.status !== 'available' && !a.derived ? `<div class="a-note derived">${esc(ADV[a.status] || a.status)}${a.statusSince ? ` · ${esc(new Date(a.statusSince).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }))} 起` : ''}${a.statusReason ? ` · ${esc(a.statusReason)}` : ''}</div>` : ''}
        ${a.notes ? `<div class="a-note">${esc(a.notes)}</div>` : ''}
      </article>`;
  }

  const BRIEFS_SHOWN = 8;

  function renderBriefs() {
    const briefs = state.snap.unpostedBriefs || [];
    if (!briefs.length) { $('#briefs').innerHTML = '<div class="empty">没有待发布的 brief</div>'; return; }
    const shown = state.briefsExpanded ? briefs : briefs.slice(0, BRIEFS_SHOWN);
    const toggle = briefs.length > BRIEFS_SHOWN
      ? `<button class="plate bf-toggle" data-briefs-toggle type="button">${state.briefsExpanded ? '收起' : `展开全部 ${briefs.length} 份`}</button>`
      : '';
    $('#briefs').innerHTML = shown.map((b) => `<div class="bf"><span class="pid">${esc(b.package)}</span><span>${esc(b.title)}</span><code>${esc(b.brief)}</code></div>`).join('') + toggle;
  }

  function renderReviews() {
    const pages = state.snap.reviewPages || [];
    $('#reviews').innerHTML = pages.length ? pages.map((p) => {
      const meter = p.total ? `<span class="meter">${Array.from({ length: p.total }, (_, i) => `<i class="${i < p.answered ? 'on' : ''}"></i>`).join('')}</span>` : '';
      return `<a class="rv" href="${esc(p.url)}" target="_blank" rel="noreferrer"><span class="rv-title">${esc(p.title)}</span><span class="rv-count">${p.error ? esc(p.error) : `已批注 ${p.answered}/${p.total}`}</span>${meter}</a>`;
    }).join('') : '<div class="empty">没有评审页</div>';
  }

  // ── node graph ─────────────────────────────────────────────────────────
  function related(id) {
    const keep = new Set([id]);
    const up = (qid) => { const q = quest(qid); if (!q) return; for (const p of q.parents || []) if (!keep.has(p)) { keep.add(p); up(p); } };
    const down = (qid) => { for (const q of state.snap.quests) if ((q.parents || []).includes(qid) && !keep.has(q.id)) { keep.add(q.id); down(q.id); } };
    up(id); down(id);
    for (const c of (quest(id) && quest(id).conflicts) || []) keep.add(c);
    for (const other of state.snap.quests) if ((other.conflicts || []).includes(id)) keep.add(other.id);
    return [...keep].filter((qid) => quest(qid));
  }

  function layout(nodes) {
    const idSet = new Set(nodes.map((q) => q.id));
    const depth = new Map();
    const levelOf = (q, seen = new Set()) => {
      if (depth.has(q.id)) return depth.get(q.id);
      if (seen.has(q.id)) return 0;
      seen.add(q.id);
      const parents = (q.parents || []).filter((p) => idSet.has(p)).map(quest);
      const level = parents.length ? 1 + Math.max(...parents.map((p) => levelOf(p, seen))) : 0;
      depth.set(q.id, level);
      return level;
    };
    nodes.forEach((q) => levelOf(q));
    return depth;
  }

  function graphSvg(ids, focus) {
    const nodes = ids.map(quest);
    const depth = layout(nodes);
    const advIds = [...new Set(nodes.flatMap((q) => (q.dispatches || []).map((d) => d.adventurerId)))];
    const W = 178, H = 48, GX = 222, GY = 64, PAD = 22;
    const shift = advIds.length ? 1 : 0;
    const rows = new Map();
    const pos = new Map();
    for (const q of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
      const level = depth.get(q.id) + shift;
      const row = rows.get(level) || 0;
      rows.set(level, row + 1);
      pos.set(q.id, { x: PAD + level * GX, y: PAD + row * GY });
    }
    advIds.forEach((id, row) => pos.set(`adv:${id}`, { x: PAD, y: PAD + row * GY }));
    const maxRows = Math.max(1, advIds.length, ...rows.values());
    const levels = Math.max(0, ...depth.values()) + 1 + shift;
    const width = PAD * 2 + (levels - 1) * GX + W, height = PAD * 2 + (maxRows - 1) * GY + H;
    const cable = (a, b, attrs) => `<path d="M${a.x + W},${a.y + H / 2} C${a.x + W + 36},${a.y + H / 2} ${b.x - 36},${b.y + H / 2} ${b.x},${b.y + H / 2}" fill="none" ${attrs}/>`;
    const edges = [];
    for (const q of nodes) {
      for (const p of q.parents || []) if (pos.has(p)) edges.push(cable(pos.get(p), pos.get(q.id), 'stroke="#c9b48f" stroke-width="2" marker-end="url(#arrow)"'));
      for (const d of q.dispatches || []) {
        const current = q.assignee && q.assignee.adventurerId === d.adventurerId && q.status === 'dispatched';
        edges.push(cable(pos.get(`adv:${d.adventurerId}`), pos.get(q.id), `stroke="${current ? '#3fae6b' : '#5f5446'}" stroke-width="${current ? 2.6 : 1.4}" stroke-dasharray="6 5"`));
      }
      for (const c of q.conflicts || []) if (pos.has(c) && q.id < c) {
        const a = pos.get(q.id), b = pos.get(c);
        edges.push(`<line x1="${a.x + W / 2}" y1="${a.y + H}" x2="${b.x + W / 2}" y2="${b.y}" stroke="#d9442e" stroke-width="1.6" stroke-dasharray="2 5"/>`);
      }
    }
    const boxes = nodes.map((q) => {
      const p = pos.get(q.id);
      const color = NODE_COLORS[q.status] || '#857b70';
      return `<g class="node" data-quest="${esc(q.id)}" transform="translate(${p.x},${p.y})">
        <rect width="${W}" height="${H}" rx="2" fill="#e9ddc1" stroke="${q.id === focus ? '#f2b134' : '#000'}" stroke-width="${q.id === focus ? 3 : 1}"/>
        <rect width="7" height="${H}" fill="${color}"/>
        <text class="g-id" x="15" y="21" fill="#241c13">${esc(q.id)}</text>
        <text class="g-sub" x="15" y="38" fill="#6d5c46">${esc(KIND[q.kind] || '')} · ${esc(STATUS[q.status] || q.status)} · ${esc((q.title || '').slice(0, 11))}</text>
      </g>`;
    });
    const advBoxes = advIds.map((id) => {
      const p = pos.get(`adv:${id}`);
      const a = adventurer(id);
      return `<g transform="translate(${p.x},${p.y})"><rect width="${W}" height="${H}" rx="10" fill="#2f2a25" stroke="#000"/>
        <circle cx="16" cy="${H / 2}" r="4" fill="#0b0907"/>
        <text class="g-sub" x="30" y="21" fill="#e9ddc1" style="font-weight:700">${esc(a ? a.name : id)}</text>
        <text class="g-sub" x="30" y="37" fill="#c9b48f">${esc(a ? a.model.slice(-24) : '')}</text></g>`;
    });
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="任务关系图">
      <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#c9b48f"/></marker></defs>
      ${edges.join('')}${advBoxes.join('')}${boxes.join('')}</svg>`;
  }

  function renderGraphView() {
    const archived = new Set(COLUMNS[4].statuses);
    const active = state.snap.quests.filter((q) => !archived.has(q.status));
    const ids = new Set(active.map((q) => q.id));
    for (const q of active) for (const p of q.parents || []) if (quest(p)) ids.add(p);
    $('#graphView').innerHTML = ids.size
      ? `<p class="hint">实线：父任务 → 子任务（编码 → 审核 → 修复）。虚线：冒险者做过的委托，绿色表示正在做。红点线：文件冲突。点节点看档案。</p>${graphSvg([...ids], state.selected)}`
      : '<div class="empty">没有进行中的委托</div>';
  }

  // ── dossier drawer ─────────────────────────────────────────────────────
  const section = (en, zh, body) => `<section class="d-sec"><h3><span>${en}</span>${zh}</h3>${body}</section>`;

  function renderDrawer() {
    const q = state.selected && quest(state.selected);
    const drawer = $('#drawer');
    if (!q) { drawer.hidden = true; return; }
    const draft = $('#rulingText') ? $('#rulingText').value : '';
    const scroll = drawer.hidden ? 0 : drawer.scrollTop;
    drawer.hidden = false;
    const verdicts = state.snap.eligibility[q.id] || {};
    const live = q.assignee ? state.snap.live[q.assignee.name] : null;
    const threads = state.snap.threads[q.id] || [];
    const page = q.reviewPage && (state.snap.reviewPages || []).find((p) => p.page === q.reviewPage);
    const picks = state.snap.roster.map((a) => {
      const v = verdicts[a.id] || { ok: false, reasons: [{ message: '无数据' }] };
      return `<div class="pick ${v.ok ? 'ok' : 'no'}"><div><strong>${esc(a.name)}</strong><span class="a-model">${esc(a.model)}</span>${v.ok ? '' : `<div class="why">${v.reasons.map((r) => esc(r.message)).join('；')}</div>`}</div>
        ${v.ok ? `<button class="btn primary" data-assign="${esc(a.id)}" type="button">派遣</button>` : ''}</div>`;
    }).join('');
    const openAny = Object.values(verdicts).some((v) => v.ok);
    drawer.innerHTML = `<button class="close" data-close type="button">✕ 关闭</button>
      <p class="eyebrow">DOSSIER · 委托档案</p>
      <div class="d-head"><span class="pid">${esc(q.id)}</span><span class="tape k-${esc(q.kind)}">${esc(KIND[q.kind] || q.kind)}</span><span class="stamp s-${esc(q.status)}">${esc(STATUS[q.status] || q.status)}</span></div>
      <h2>${esc(q.title)}</h2>
      <div class="d-meta">发布者 ${esc(q.postedBy || '—')}${q.brief ? ` · brief <code>${esc(q.brief)}</code>` : ''}</div>
      ${q.needsOwner ? section('YOUR CALL', '等你裁决', `<div class="ask-box">${esc(q.needsOwner)}</div><textarea id="rulingText" rows="3" placeholder="写下你的决定，coordinator 会收到"></textarea><div class="row end"><button class="btn primary" data-rule type="button">盖章裁决</button></div>`) : ''}
      ${q.assignee ? section('ON QUEST', '正在做', `<div class="rec">⚔ ${esc(q.assignee.model)} · worker <code>${esc(q.assignee.name)}</code> · ${clock(q.assignee.at)} 派出${live ? ` · ${esc(live.state)} · ${ago(live.elapsed)}` : ''}</div>${live && live.lastText ? `<pre>${esc(live.lastText)}</pre>` : ''}`) : ''}
      ${q.lastDetail ? section('LAST WORD', '最近结果', `<pre>${esc(q.lastDetail)}</pre>`) : ''}
      ${section('ASSIGN', `指派冒险者${openAny ? '' : '（现在谁都不能接）'}`, picks)}
      ${section('WIRING', '关系图', `<div class="graph-wrap" style="min-height:0">${graphSvg(related(q.id), q.id)}</div>`)}
      ${page ? section('INSPECTION', '评审页', `<a class="rv" href="${esc(page.url)}" target="_blank" rel="noreferrer"><span class="rv-title">${esc(page.title)}</span><span class="rv-count">已批注 ${page.answered}/${page.total}</span></a>`) : ''}
      ${threads.length ? section('CHATTER', '留言板', threads.map((t) => `<div class="rec"><a href="/?thread=${encodeURIComponent(t.id)}" target="_blank" rel="noreferrer">${esc(t.title)}</a> · ${t.messageCount} 条${t.closed ? ' · 已关闭' : ''}</div>`).join('')) : ''}
      ${(q.dispatches || []).length ? section('LOG', '派遣记录', q.dispatches.map((d) => `<div class="rec">${new Date(d.at).toLocaleString('zh-CN')} · ${esc(d.model)} · <code>${esc(d.name)}</code> · ${esc(d.by || '')}</div>`).join('')) : ''}
      ${(q.rulings || []).length ? section('RULINGS', '裁决记录', q.rulings.map((r) => `<div class="rec">${new Date(r.at).toLocaleString('zh-CN')} · 问：${esc(r.question || '')} · 答：${esc(r.text)}</div>`).join('')) : ''}
      ${['done', 'superseded', 'cancelled'].includes(q.status) ? '' : section('SCRAP', '操作', '<button class="btn danger" data-cancel type="button">取消这个委托</button>')}`;
    if (draft && $('#rulingText')) $('#rulingText').value = draft;
    drawer.scrollTop = scroll;
  }

  // ── work orders ────────────────────────────────────────────────────────
  function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; }

  function confirmAssign(questId, advId) {
    const q = quest(questId), a = adventurer(advId);
    const modal = $('#modal');
    modal.hidden = false;
    modal.innerHTML = `<div class="order" role="dialog" aria-modal="true" aria-labelledby="orderTitle">
      <p class="eyebrow">WORK ORDER · 派遣令</p>
      <h2 id="orderTitle">派 <em>${esc(a.name)}</em> 去做 <em>${esc(q.id)}</em></h2>
      <dl class="order-lines"><dt>委托</dt><dd>${esc(q.title)}</dd><dt>冒险者</dt><dd>${esc(a.provider)} · ${esc(a.lane)}</dd><dt>模型</dt><dd><code>${esc(a.model)}${a.variant ? ` · ${esc(a.variant)}` : ''}</code></dd><dt>BRIEF</dt><dd><code>${esc(q.brief)}</code></dd></dl>
      ${a.billing === 'payg' ? '<div class="warn-tape">⚠ 按量付费通道，会直接花钱</div>' : ''}
      ${q.status === 'stalled' ? '<div class="warn-tape">⚠ 上一个 worker 卡住了，但可能还在改文件。确认它已经停了再派。</div>' : ''}
      <div id="assignError"></div>
      <div class="row end"><button class="btn ghost" data-modal-close type="button">算了</button><button class="btn primary" data-confirm type="button">盖章派遣</button></div></div>`;
    const confirm = modal.querySelector('[data-confirm]');
    confirm.focus();
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      try {
        await api(`/api/quests/${encodeURIComponent(q.id)}/assign`, 'POST', { adventurer: a.id, by: 'owner' });
        closeModal();
        refresh();
      } catch (error) {
        confirm.disabled = false;
        $('#assignError').innerHTML = `<ul class="reasons">${(error.reasons.length ? error.reasons.map((r) => r.message) : [error.message]).map((m) => `<li>${esc(m)}</li>`).join('')}</ul>`;
      }
    });
  }

  function editAdventurer(advId) {
    const a = adventurer(advId);
    // The manual layer, not the possibly-derived a.status/a.statusReason (feedback9: saving unchanged must
    // never persist a lane-derived "limited"). An older server without baseStatus falls back to status,
    // which is equivalent whenever there is no derived overlay anyway.
    const baseStatus = a.baseStatus ?? a.status;
    const baseReason = a.baseReason ?? a.statusReason ?? '';
    const modal = $('#modal');
    modal.hidden = false;
    modal.innerHTML = `<div class="order" role="dialog" aria-modal="true" aria-labelledby="idTitle">
      <p class="eyebrow">ID CARD · 冒险者档案</p><h2 id="idTitle">${esc(a.name)}</h2>
      <dl class="order-lines"><dt>模型</dt><dd><code>${esc(a.model)}</code></dd><dt>通道</dt><dd>${esc(a.provider)} · ${esc(a.lane)}</dd></dl>
      ${a.derived ? `<div class="a-note derived" role="note" style="color:var(--ink)">
        <p>自动判断：${esc(a.derived.reason)}</p>
        <p>${a.derived.resetsAt ? `预计 ${esc(clock(a.derived.resetsAt))} 恢复` : '重置时间未知'}</p>
        <button class="btn ghost" type="button" id="advConfirmRestored">确认额度已恢复</button>
        <p>只是登记，不会向服务商核实额度是否真的恢复。</p>
      </div>` : ''}
      <label for="advStatus">STATUS 状态</label><select id="advStatus">${Object.entries(ADV).map(([k, v]) => `<option value="${k}"${k === baseStatus ? ' selected' : ''}>${v}</option>`).join('')}</select>
      <label for="advNote">REASON 原因（会显示在工牌上，写明为什么、到什么时候）</label><input id="advNote" maxlength="300" value="${esc(baseReason)}">
      <div class="row end"><button class="btn ghost" data-modal-close type="button">算了</button><button class="btn primary" data-save type="button">盖章保存</button></div></div>`;
    // B1: a second 确认额度已恢复 after an earlier one already left base at available/该原因 must still
    // write, not silently no-op because status/reason now match base again. Any manual edit to the fields
    // after clicking it cancels that guarantee — it is no longer "just confirmed", it is a fresh edit.
    let confirmed = false;
    if (a.derived) {
      modal.querySelector('#advConfirmRestored').addEventListener('click', () => {
        $('#advStatus').value = 'available';
        $('#advNote').value = '已手动确认额度恢复';
        confirmed = true;
      });
    }
    $('#advStatus').addEventListener('change', () => { confirmed = false; });
    $('#advNote').addEventListener('input', () => { confirmed = false; });
    modal.querySelector('[data-save]').addEventListener('click', async () => {
      const status = $('#advStatus').value;
      const reason = $('#advNote').value;
      if (!confirmed && status === baseStatus && reason === baseReason) {
        // Nothing the owner actually changed — never write a status here, derived or otherwise.
        closeModal();
        refresh();
        return;
      }
      try {
        await api(`/api/roster/${encodeURIComponent(a.id)}/status`, 'POST', { status, reason, setBy: 'owner' });
        closeModal();
        refresh();
      } catch (error) { toast(`保存失败：${error.message}`); }
    });
  }

  // ── picking: the refusal is visible before the drop ────────────────────
  function showPicking(advId) {
    state.picking = advId;
    document.body.classList.add('picking');
    document.querySelectorAll('.quest[data-quest]').forEach((card) => {
      const q = quest(card.dataset.quest);
      const v = (state.snap.eligibility[card.dataset.quest] || {})[advId];
      const open = q && COLUMNS[0].statuses.includes(q.status);
      // Waiting only for a running quest to finish reads as a queue, not a refusal.
      const queued = Boolean(v && !v.ok && open && v.reasons.every((r) => r.code === 'conflict_running'));
      card.classList.toggle('drop-ok', Boolean(v && v.ok));
      card.classList.toggle('drop-queue', queued);
      card.classList.toggle('drop-no', Boolean(v && !v.ok && open && !queued));
      card.querySelector('.q-refuse').textContent = v && !v.ok ? `✗ ${v.reasons[0].message}${v.reasons.length > 1 ? `（还有 ${v.reasons.length - 1} 条）` : ''}` : '';
    });
  }

  function clearPicking() {
    state.picking = null;
    document.body.classList.remove('picking');
    document.querySelectorAll('.quest').forEach((card) => card.classList.remove('drop-ok', 'drop-no', 'drop-queue', 'over'));
  }

  // ── render loop ────────────────────────────────────────────────────────
  function render() {
    renderChips();
    if (state.view === 'board') renderBoard(); else renderGraphView();
    renderGuild();
    renderReviews();
    renderBriefs();
    renderDrawer();
    if (state.picking && state.view === 'board') showPicking(state.picking);
    for (const q of state.snap.quests) { state.seen.add(q.id); state.lastStatus.set(q.id, q.status); }
  }

  async function refresh() {
    try {
      state.snap = await api('/api/quests');
      if (!isDragging()) render();
    } catch (error) {
      $('#chips').innerHTML = chip('bad', `读取失败：${esc(error.message)}`);
    }
  }

  function scheduleRefresh() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(refresh, 250);
  }

  function describe(event) {
    const who = event.model ? `（${event.model}）` : '';
    const text = { posted: `新委托 ${event.package}`, review_posted: `新审核委托 ${event.package}`, assigned: `${event.package} 已指派${who}`, dispatched: `${event.package} 脚本已启动${who}`, delivery_write_failed: `${event.package} 交付文件没写成：${event.detail}`, delivered: `${event.package} 已交付${who}`, failed: `${event.package} 失败${who}`, bounced: `${event.package} 限额退回${who}`, stalled: `${event.package} 卡住了${who}`, cancelled: `${event.package} 已取消`, owner_ruling: `${event.package} 已裁决` }[event.event];
    return text || `${event.package} → ${STATUS[String(event.event).replace(/^status_/, '')] || event.event}`;
  }

  // ── wiring ─────────────────────────────────────────────────────────────
  function onClick(event) {
    const t = event.target;
    if (t.closest('[data-modal-close]') || t === $('#modal')) { closeModal(); return; }
    if (t.closest('[data-close]')) { state.selected = null; renderDrawer(); return; }
    if (t.closest('[data-briefs-toggle]')) { state.briefsExpanded = !state.briefsExpanded; renderBriefs(); return; }
    const assign = t.closest('[data-assign]');
    if (assign) { confirmAssign(state.selected, assign.dataset.assign); return; }
    if (t.closest('[data-rule]')) {
      const text = $('#rulingText').value.trim();
      if (!text) { toast('先写下裁决内容'); return; }
      api(`/api/quests/${encodeURIComponent(state.selected)}/ruling`, 'POST', { text, by: 'owner' })
        .then(() => { $('#rulingText').value = ''; return refresh(); }).catch((e) => toast(`裁决失败：${e.message}`));
      return;
    }
    if (t.closest('[data-cancel]')) {
      if (!window.confirm(`取消 ${state.selected}？已经在跑的 worker 不会被停止。`)) return;
      api(`/api/quests/${encodeURIComponent(state.selected)}/status`, 'POST', { status: 'cancelled', detail: 'owner 在任务板上取消', by: 'owner' }).then(refresh).catch((e) => toast(`取消失败：${e.message}`));
      return;
    }
    const tab = t.closest('[data-view]');
    if (tab) {
      state.view = tab.dataset.view;
      document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b === tab));
      $('#boardView').hidden = state.view !== 'board';
      $('#graphView').hidden = state.view !== 'graph';
      render();
      return;
    }
    const card = t.closest('[data-quest]');
    if (card) { state.selected = card.dataset.quest; renderDrawer(); if (state.view === 'graph') renderGraphView(); return; }
    const adv = t.closest('[data-adv]');
    if (adv) editAdventurer(adv.dataset.adv);
  }

  function wireDragAndDrop() {
    const guild = $('#guild');
    guild.addEventListener('mouseover', (event) => {
      const adv = event.target.closest('[data-adv]');
      if (adv && state.picking !== adv.dataset.adv && !isDragging()) showPicking(adv.dataset.adv);
    });
    guild.addEventListener('mouseleave', () => { if (!isDragging()) clearPicking(); });
    guild.addEventListener('dragstart', (event) => {
      const adv = event.target.closest('[data-adv]');
      if (!adv) return;
      event.dataTransfer.setData('text/plain', adv.dataset.adv);
      event.dataTransfer.effectAllowed = 'move';
      adv.classList.add('is-dragging');
      document.body.classList.add('dragging');
      showPicking(adv.dataset.adv);
    });
    document.addEventListener('dragend', () => {
      document.body.classList.remove('dragging');
      document.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
      clearPicking();
      if (state.snap) render();
    });
    const board = $('#boardView');
    board.addEventListener('dragover', (event) => {
      const card = event.target.closest('.quest.drop-ok');
      if (!card) return;
      event.preventDefault();
      document.querySelectorAll('.quest.over').forEach((c) => c !== card && c.classList.remove('over'));
      card.classList.add('over');
    });
    board.addEventListener('drop', (event) => {
      const card = event.target.closest('.quest.drop-ok');
      if (!card) return;
      event.preventDefault();
      const advId = event.dataTransfer.getData('text/plain');
      document.body.classList.remove('dragging');
      clearPicking();
      confirmAssign(card.dataset.quest, advId);
    });
  }

  function connect() {
    const stream = new EventSource('/api/quests/stream');
    stream.addEventListener('hello', () => { state.connected = true; scheduleRefresh(); });
    stream.addEventListener('quest', (message) => {
      try { toast(describe(JSON.parse(message.data))); } catch { /* malformed frame: the refresh still shows the truth */ }
      scheduleRefresh();
    });
    stream.onerror = () => { state.connected = false; if (state.snap) renderChips(); };
  }

  document.addEventListener('click', onClick);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeModal(); state.selected = null; renderDrawer(); }
    if (event.key === 'Enter' && event.target.matches('[data-quest],[data-adv]')) event.target.click();
  });
  wireDragAndDrop();
  connect();
  refresh();
  setInterval(() => { if (!isDragging() && $('#modal').hidden) refresh(); }, 10000);
})();
