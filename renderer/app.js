'use strict';
// Screen logic: draws the panels and animates whatever the cluster (or demo) reports.

const IDS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];
const ORCH = 'ORCH';
const ALL = [...IDS, ORCH]; // the orchestrator is a seventh agent with no box of its own
const THEME = new URLSearchParams(location.search).get('theme') || 'cluster';
const BUCKET_MS = 5 * 60 * 1000, SLOTS = 36; // usage chart: 36 bars of 5 minutes = 3 hours
document.getElementById('theme').href = `themes/${THEME}.css`;
const $ = s => document.querySelector(s);
const fmt = n => Math.round(n).toLocaleString('en-US');
const pad = n => String(n).padStart(2, '0');

const S = {
  agents: {},
  sel: 'C1',
  mode: 'individual',
  demo: false,
  chats: [],
  feeds: Object.fromEntries(ALL.map(id => [id, []])),
  linkOrder: [],
  linkActive: new Set(),
  bars: new Map(), // 5-minute slot number -> tokens used in it
  lastTotal: 0,
  prog: Object.fromEntries(IDS.map(id => [id, 0])),
  code: Object.fromEntries(IDS.map(id => [id, { key: '', text: '', pos: 0, shown: -1 }])),
};
const blank = id => ({ id, status: 'IDLE', busy: false, tasks: [], ctx: 0, used: 0, connected: [], watch: 'NOMINAL', queued: 0, code: null });
S.agents[ORCH] = blank(ORCH);

// ---------- agent boxes ----------
function buildAgents() {
  for (const id of IDS) {
    const el = document.createElement('section');
    el.className = 'box agent';
    el.dataset.id = id;
    el.innerHTML = `
      <div class="head"><span class="aid">${id}</span><span class="status">IDLE</span></div>
      <div class="prog"><div class="bar"><div class="fill"></div><div class="blocks"></div></div><span class="pct">000%</span></div>
      <div class="task">NO ACTIVE TASK</div>
      <div class="metrics"><span>CTX<b class="ctx">0</b></span><span>USED<b class="used">0</b></span><span>QUEUE<b class="q">0</b></span></div>
      <div class="conn">NOT CONNECTED</div>
      <div class="code"><div class="file none">NO CODE</div><div class="src"></div></div>
      <div class="watch">WATCHDOG: NOMINAL</div>`;
    el.addEventListener('click', () => select(id));
    (IDS.indexOf(id) < 3 ? $('#left') : $('#right')).appendChild(el);
    S.agents[id] = blank(id);
  }
}

function box(id) { return document.querySelector(`.agent[data-id="${id}"]`); }

function renderAgent(a) {
  if (a.id === ORCH) {
    document.querySelector('#hex .node.orch')?.classList.toggle('busy', a.busy);
    renderLinks();
    return;
  }
  const el = box(a.id);
  if (!el) return;
  el.classList.toggle('busy', a.busy);
  const st = el.querySelector('.status');
  st.textContent = a.status;
  st.classList.toggle('warn', /AWAIT|COMPACT/.test(a.status));
  const done = a.tasks.filter(t => t.status === 'completed').length;
  const now = a.tasks.find(t => t.status === 'in_progress');
  const task = el.querySelector('.task');
  if (now) task.innerHTML = `<span class="n">${a.tasks.indexOf(now) + 1}/${a.tasks.length}</span>${esc(now.text)}`;
  else if (a.tasks.length && done === a.tasks.length) task.innerHTML = `<span class="n">${done}/${done}</span>ALL TASKS COMPLETE`;
  else task.textContent = a.busy ? 'PROCESSING…' : 'NO ACTIVE TASK';
  const blocks = el.querySelector('.blocks');
  if (blocks.childElementCount !== Math.max(0, a.tasks.length - 1)) {
    blocks.innerHTML = '';
    for (let i = 1; i < a.tasks.length; i++) {
      const s = document.createElement('span');
      s.style.left = (i / a.tasks.length * 100) + '%';
      blocks.appendChild(s);
    }
  }
  setCode(a);
  el.querySelector('.ctx').textContent = fmt(a.ctx);
  el.querySelector('.used').textContent = fmt(a.used);
  el.querySelector('.q').textContent = a.queued;
  const conn = el.querySelector('.conn');
  conn.textContent = a.connected.length ? 'CONNECTED TO ' + a.connected.join(', ') : 'NOT CONNECTED';
  conn.classList.toggle('on', a.connected.length > 0);
  const w = el.querySelector('.watch');
  w.textContent = 'WATCHDOG: ' + a.watch;
  w.classList.toggle('warn', !/^NOMINAL/.test(a.watch));
  const node = document.querySelector(`#hex .node[data-id="${a.id}"]`);
  if (node) node.classList.toggle('busy', a.busy);
}

// ---------- code view: the code each agent is writing, typed out ----------
// New code (another file or a new write) types out from the top; the box shows the
// last rows typed so far, so it scrolls like an editor. Only whole rows are shown.
function setCode(a) {
  const c = S.code[a.id], k = a.code ? a.code.file + '|' + a.code.t : '';
  if (k === c.key) return;
  c.key = k;
  c.text = a.code ? String(a.code.text || '').replace(/\r/g, '') : '';
  c.pos = 0;
  c.shown = -1;
  const file = box(a.id).querySelector('.code .file');
  file.textContent = a.code ? String(a.code.file || '').split(/[\\/]/).pop() : 'NO CODE';
  file.classList.toggle('none', !a.code);
  drawCode(a.id);
}

function drawCode(id) {
  const c = S.code[id];
  if (c.shown === c.pos) return;
  c.shown = c.pos;
  const src = box(id).querySelector('.code .src');
  const lh = parseFloat(getComputedStyle(src).lineHeight) || 18;
  const rows = Math.floor(src.clientHeight / lh);
  if (rows < 1 || !c.text) { src.innerHTML = ''; return; }
  const lines = c.text.slice(0, c.pos).split('\n').slice(-rows);
  const typing = c.pos < c.text.length;
  src.innerHTML = lines.map((l, i) => `<div${typing && i === lines.length - 1 ? ' class="cursor"' : ''}>${esc(l) || ' '}</div>`).join('');
}

function typeCode() {
  for (const id of IDS) {
    const c = S.code[id];
    if (c.pos < c.text.length) c.pos = Math.min(c.text.length, c.pos + Math.max(3, Math.ceil((c.text.length - c.pos) / 90)));
    drawCode(id);
  }
}

// Progress meter: creeps toward ~90% of the current task's block on a timer,
// then jumps to the block edge when the task is actually marked complete.
function tickProgress() {
  for (const id of IDS) {
    const a = S.agents[id];
    const n = a.tasks.length;
    let base = 0, cap = 0;
    if (n) {
      const done = a.tasks.filter(t => t.status === 'completed').length;
      base = done / n * 100;
      cap = a.busy && done < n ? base + (100 / n) * 0.9 : base;
    }
    let p = S.prog[id];
    if (p > cap + 0.01) p = base;                       // new task list: restart
    else if (p < base) p = Math.min(base, p + Math.max(1.5, (base - p) * 0.35));
    else if (p < cap) p = Math.min(cap, p + (100 / n) * 0.012 * (0.4 + Math.random()));
    S.prog[id] = p;
    const el = box(id);
    el.querySelector('.fill').style.width = p + '%';
    const cells = 24, full = Math.round(p / 100 * cells);
    el.querySelector('.bar').dataset.text = '[' + '#'.repeat(full) + '.'.repeat(cells - full) + ']';
    el.querySelector('.pct').textContent = String(Math.floor(p)).padStart(3, '0') + '%';
  }
}

// ---------- hexagon ----------
const NODES = {};
const PAIRS = [];
const SPOKES = [];
function buildHex() {
  const svg = $('#hex');
  const cx = 120, cy = 100, r = 78;
  IDS.forEach((id, i) => {
    const ang = (-90 + i * 60) * Math.PI / 180;
    NODES[id] = { x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) };
  });
  const ns = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) {
    const a = IDS[i], b = IDS[j], key = a + '-' + b;
    PAIRS.push(key);
    const ln = document.createElementNS(ns, 'line');
    ln.setAttribute('class', 'edge');
    ln.dataset.key = key;
    ln.setAttribute('x1', NODES[a].x); ln.setAttribute('y1', NODES[a].y);
    ln.setAttribute('x2', NODES[b].x); ln.setAttribute('y2', NODES[b].y);
    svg.appendChild(ln);
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('class', 'order');
    t.dataset.key = key;
    // Offset toward the middle so labels on crossing lines don't stack.
    t.setAttribute('x', (NODES[a].x * 0.55 + NODES[b].x * 0.45));
    t.setAttribute('y', (NODES[a].y * 0.55 + NODES[b].y * 0.45) - 2);
    svg.appendChild(t);
  }
  // Orchestrator in the middle with a spoke to every agent (orch mode only).
  NODES[ORCH] = { x: cx, y: cy };
  for (const id of IDS) {
    const key = id + '-' + ORCH;
    SPOKES.push(key);
    const ln = document.createElementNS(ns, 'line');
    ln.setAttribute('class', 'edge spoke');
    ln.dataset.key = key;
    ln.setAttribute('x1', cx); ln.setAttribute('y1', cy);
    ln.setAttribute('x2', NODES[id].x); ln.setAttribute('y2', NODES[id].y);
    svg.appendChild(ln);
  }
  const og = document.createElementNS(ns, 'g');
  og.setAttribute('class', 'node orch');
  og.dataset.id = ORCH;
  og.innerHTML = `<rect x="${cx - 21}" y="${cy - 11}" width="42" height="22"></rect><text x="${cx}" y="${cy}">ORCH</text>`;
  svg.appendChild(og);
  for (const id of IDS) {
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'node');
    g.dataset.id = id;
    g.innerHTML = `<rect x="${NODES[id].x - 15}" y="${NODES[id].y - 11}" width="30" height="22"></rect><text x="${NODES[id].x}" y="${NODES[id].y}">${id}</text>`;
    g.addEventListener('click', () => select(id));
    svg.appendChild(g);
  }
}

function renderLinks() {
  const orch = S.mode === 'orch';
  $('#hex').classList.toggle('orch', orch);
  const peerOrder = S.linkOrder.filter(k => !k.includes(ORCH));
  PAIRS.forEach(key => {
    const ln = document.querySelector(`#hex .edge[data-key="${key}"]`);
    const label = document.querySelector(`#hex .order[data-key="${key}"]`);
    const order = peerOrder.indexOf(key);
    const active = S.linkActive.has(key);
    ln.classList.toggle('seen', order >= 0);
    ln.classList.toggle('active', active);
    ln.classList.toggle('pulse', active);
    label.textContent = order >= 0 ? order + 1 : '';
    label.classList.toggle('seen', order >= 0);
  });
  SPOKES.forEach(key => {
    const ln = document.querySelector(`#hex .edge[data-key="${key}"]`);
    ln.classList.toggle('seen', orch && S.linkOrder.includes(key));
    ln.classList.toggle('active', orch && S.linkActive.has(key));
  });
  const active = [...S.linkActive];
  $('#netSub').textContent = orch
    ? `STAR · ${active.length} ACTIVE · ORCH ${S.agents[ORCH].status}`
    : `${peerOrder.length} / 15 LINKS · ${active.filter(k => !k.includes(ORCH)).length} ACTIVE`;
}

// ---------- usage ----------
function renderUsage() {
  const list = ALL.map(id => S.agents[id]);
  const total = list.reduce((s, a) => s + a.used, 0);
  $('#total').textContent = fmt(total);
  const delta = total - S.lastTotal;
  const slot = Math.floor(Date.now() / BUCKET_MS);
  if (delta > 0) S.bars.set(slot, (S.bars.get(slot) || 0) + delta);
  S.lastTotal = total;
  renderBars(slot);
  const top = list.slice().sort((a, b) => b.used - a.used).slice(0, 3);
  const tmax = Math.max(1, top[0].used);
  $('#top3').innerHTML = top.map(a => `<div class="row"><span>${a.id}</span><div class="bar"><i style="width:${a.used / tmax * 100}%"></i></div><span class="num">${fmt(a.used)}</span></div>`).join('');
}

// Bar chart that scrolls left as time passes; the rightmost bar is the current 5 minutes.
function renderBars(slot = Math.floor(Date.now() / BUCKET_MS)) {
  for (const k of S.bars.keys()) if (k <= slot - SLOTS) S.bars.delete(k);
  const w = 300, h = 60, bw = w / SLOTS;
  const vals = Array.from({ length: SLOTS }, (_, i) => S.bars.get(slot - SLOTS + 1 + i) || 0);
  const max = Math.max(1, ...vals);
  const rects = vals.map((v, i) => {
    const bh = v ? Math.max(1, v / max * (h - 4)) : 0;
    return `<rect class="bar${i === SLOTS - 1 ? ' now' : ''}" x="${(i * bw + 1).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}"/>`;
  }).join('');
  $('#spark').innerHTML = `${rects}<line class="base" x1="0" y1="${h - 0.5}" x2="${w}" y2="${h - 0.5}"/>`;
}

// Demo only: fill in a believable past three hours so the chart isn't empty.
function seedDemoBars() {
  const slot = Math.floor(Date.now() / BUCKET_MS);
  for (let i = 1; i < SLOTS; i++) {
    const wave = 0.5 + 0.5 * Math.sin(i / 4);
    if (Math.random() < 0.12) continue;
    S.bars.set(slot - i, Math.round(60000 + 220000 * wave * Math.random()));
  }
}

// ---------- execution feed (typed out, speeds up when it falls behind) ----------
const typing = [];
function feedVisible(id) { return S.mode === 'orch' || id === S.sel; }

function makeLine(e) {
  const d = document.createElement('div');
  d.className = 'ln ' + e.kind;
  if (S.mode === 'orch') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = e.id;
    d.appendChild(tag);
  }
  const body = document.createElement('span');
  d.appendChild(body);
  return { d, body };
}

function addFeed(e) {
  const arr = S.feeds[e.id] || (S.feeds[e.id] = []);
  arr.push(e);
  if (arr.length > 200) arr.shift();
  if (!feedVisible(e.id)) return;
  const { d, body } = makeLine(e);
  $('#feed').appendChild(d);
  typing.push({ d, body, text: e.text, pos: 0 });
  trimFeed();
}

function trimFeed() {
  const f = $('#feed');
  while (f.childElementCount > 160) f.firstChild.remove();
}

function typeLoop() {
  if (typing.length) {
    const backlog = typing.reduce((s, t) => s + t.text.length - t.pos, 0);
    let budget = Math.max(4, Math.ceil(backlog / 45));
    while (budget > 0 && typing.length) {
      const t = typing[0];
      const n = Math.min(budget, t.text.length - t.pos);
      t.body.textContent += t.text.slice(t.pos, t.pos + n);
      t.pos += n;
      budget -= n;
      t.d.classList.add('cursor');
      if (t.pos >= t.text.length) { t.d.classList.remove('cursor'); typing.shift(); }
    }
  }
  typeCode();
  requestAnimationFrame(typeLoop);
}

function rebuildFeed() {
  typing.length = 0;
  const f = $('#feed');
  f.innerHTML = '';
  const entries = S.mode === 'orch'
    ? ALL.flatMap(id => S.feeds[id] || []).sort((a, b) => a.t - b.t).slice(-120)
    : S.feeds[S.sel].slice(-120);
  for (const e of entries) {
    const { d, body } = makeLine(e);
    body.textContent = e.text;
    f.appendChild(d);
  }
  $('#feedSub').textContent = S.mode === 'orch' ? '// ALL AGENTS' : '// ' + S.sel;
}

// ---------- chat ----------
function chatVisible(m) { return S.mode === 'orch' || m.id === S.sel; }

function msgEl(m) {
  const d = document.createElement('div');
  d.className = 'msg ' + m.role;
  const tm = new Date(m.t || Date.now());
  const ts = `${pad(tm.getHours())}:${pad(tm.getMinutes())}`;
  const who = {
    user: `OPERATOR > ${m.id}`,
    agent: m.id,
    peer: `${m.from} > ${m.id} · ${String(m.kind || 'request').toUpperCase()}`,
    sys: `${m.id} · SYSTEM`,
  }[m.role] || m.id;
  d.innerHTML = `<div class="who">${who} · ${ts}</div><div class="body"></div>`;
  d.querySelector('.body').textContent = m.text;
  return d;
}

function addChat(m) {
  S.chats.push(m);
  if (S.chats.length > 1500) S.chats.shift();
  if (!chatVisible(m)) return;
  const c = $('#chat');
  const stick = c.scrollTop + c.clientHeight >= c.scrollHeight - 40;
  c.querySelector('.empty')?.remove();
  c.appendChild(msgEl(m));
  if (stick) c.scrollTop = c.scrollHeight;
}

function rebuildChat() {
  const c = $('#chat');
  c.innerHTML = '';
  const list = S.chats.filter(chatVisible).slice(-300);
  if (!list.length) c.innerHTML = `<div class="empty">${S.mode === 'orch' ? 'ORCH MODE · INSTRUCT THE ORCHESTRATOR' : 'NO TRANSMISSIONS · ' + S.sel}</div>`;
  for (const m of list) c.appendChild(msgEl(m));
  c.scrollTop = c.scrollHeight;
  const orch = S.mode === 'orch';
  $('#chatSub').textContent = `// OPERATOR / ${orch ? 'ORCHESTRATOR' : S.sel}`;
  $('#input').placeholder = `Instruct ${orch ? 'the orchestrator' : S.sel}…   (ENTER SENDS / SHIFT+ENTER NEW LINE)`;
}

// ---------- header ----------
function tickClock() {
  const now = new Date();
  $('#date').textContent = now.toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase().replace(/,/g, '');
  $('#utc').textContent = now.toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false });
  // Second clock: this computer's own time zone.
  $('#cst').textContent = now.toLocaleTimeString('en-GB', { hour12: false });
  const abbr = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(now).find(p => p.type === 'timeZoneName');
  $('#ctLabel').textContent = abbr ? abbr.value.toUpperCase() : 'LOCAL';
}

function renderMode() {
  const orch = S.mode === 'orch';
  const mt = $('#modeText');
  mt.querySelector('.word').textContent = orch ? 'ORCH' : 'INDIVIDUAL';
  mt.classList.toggle('focus', orch);
  document.querySelectorAll('.agent').forEach(el => el.classList.toggle('sel', !orch && el.dataset.id === S.sel));
  document.querySelectorAll('#hex .node').forEach(el => el.classList.toggle('sel', !orch && el.dataset.id === S.sel));
}

function select(id) {
  if (S.mode === 'orch' || S.sel === id || !IDS.includes(id)) return;
  S.sel = id;
  renderMode();
  rebuildFeed();
  rebuildChat();
}

// ---------- state ----------
function loadState(st, keepLogs) {
  S.mode = st.mode === 'focus' ? 'orch' : st.mode;
  if (st.demo !== undefined) S.demo = st.demo;
  if (!keepLogs) {
    S.chats = [];
    for (const id of ALL) S.feeds[id] = [];
    S.linkOrder = [];
    S.linkActive.clear();
    S.bars = new Map();
    S.lastTotal = 0;
    if (S.demo) seedDemoBars();
    for (const id of IDS) S.prog[id] = 0;
  }
  if (!keepLogs && st.chats) S.chats = st.chats.slice();
  if (!keepLogs && st.feeds) for (const id of ALL) S.feeds[id] = (st.feeds[id] || []).slice();
  if (!st.agents.some(a => a.id === ORCH)) S.agents[ORCH] = blank(ORCH);
  for (const a of st.agents) { S.agents[a.id] = a; renderAgent(a); }
  S.lastTotal = ALL.reduce((s, id) => s + (S.agents[id].used || 0), 0);
  $('#workspace').textContent = 'PROJECT ▸ ' + st.workspace;
  renderMode();
  renderLinks();
  renderUsage();
  rebuildFeed();
  rebuildChat();
}

window.ct.on(({ type, data }) => {
  switch (type) {
    case 'agent': S.agents[data.id] = data; renderAgent(data); renderUsage(); break;
    case 'chat': addChat(data); break;
    case 'feed': addFeed(data); break;
    case 'link': {
      const key = [data.a, data.b].sort().join('-');
      if (data.active && !S.linkOrder.includes(key)) S.linkOrder.push(key);
      if (data.active) S.linkActive.add(key); else S.linkActive.delete(key);
      renderLinks();
      break;
    }
    case 'reset': loadState(data, false); break;
  }
});

// ---------- controls ----------
// A note in the chat from the app itself (not saved, not sent to an agent).
function note(text) {
  S.chats.push({ id: S.mode === 'orch' ? ORCH : S.sel, role: 'sys', text, t: Date.now() });
  rebuildChat();
}

const HELP = `COMMANDS
/help         this list
/orch         orch mode: you talk to the orchestrator (ORCH), which plans the
              work, hands each of C1–C6 its own files and settles disputes
              (/focus does the same)
/individual   individual mode: each agent gets its own task
              (switching modes clears every session)
/clear        fresh session for the selected agent (ORCH in orch mode)
/clearall     fresh session for every agent, mode unchanged
/stats        where each agent's time went this run (/stats reset)
/demo         demo mode on/off (fake agents, uses no Claude usage)
/settings     open the settings file (model, permission mode, limits)

KEYS
Tab / Shift+Tab   select the next / previous agent (or click an agent box)
Enter             send · Shift+Enter new line
HALT              stop the selected agent (the whole cluster in orch mode)
F11               full screen
Click PROJECT ▸   choose the folder the agents work in`;

// Terminal commands: /orch (alias /focus) and /individual switch modes (clearing every session), /clearall clears
// every session without changing mode, /demo toggles demo mode. /clear (one agent) is handled by the engine.
const COMMANDS = {
  '/help': async () => note(HELP),
  '/settings': async () => { await window.ct.settings(); note('Opened the settings file. Save it, then restart Cluster Terminal for changes to apply.'); },
  '/orch': async () => loadState(await window.ct.mode('orch'), false),
  '/focus': async () => loadState(await window.ct.mode('orch'), false),
  '/clearall': async () => loadState(await window.ct.clearAll(), false),
  '/individual': async () => loadState(await window.ct.mode('individual'), false),
  '/demo': async () => loadState(await window.ct.demo(!S.demo), false),
};

function send() {
  const t = $('#input').value.trim();
  if (!t) return;
  const cmd = COMMANDS[t.toLowerCase()];
  $('#input').value = '';
  if (cmd) return cmd();
  if (!S.demo) window.ct.send(S.mode === 'orch' ? ORCH : S.sel, t);
}

$('#input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
// Tab / Shift+Tab cycle through the agents instead of moving between buttons.
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const i = IDS.indexOf(S.sel);
  select(IDS[(i + (e.shiftKey ? IDS.length - 1 : 1)) % IDS.length]);
  $('#input').focus();
});
$('#sendBtn').addEventListener('click', send);
$('#stopBtn').addEventListener('click', () => window.ct.stop(S.mode === 'orch' ? ORCH : S.sel));
$('#workspace').addEventListener('click', async () => {
  const st = await window.ct.workspace();
  if (st) loadState(st, false);
});

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

buildAgents();
buildHex();
tickClock();
setInterval(tickClock, 1000);
setInterval(tickProgress, 250);
window.addEventListener('resize', () => { for (const id of IDS) S.code[id].shown = -1; });
setInterval(() => renderBars(), 10000);
requestAnimationFrame(typeLoop);
window.ct.state().then(async st => {
  loadState(st, false);
  const info = await window.ct.info();
  if (info.problems.length) note('SETUP NEEDED BEFORE THE AGENTS CAN RUN\n\n' + info.problems.join('\n\n'));
  else if (!st.chats.length) note('WELCOME TO CLUSTER TERMINAL\nType a task for ' + (S.mode === 'orch' ? ORCH : S.sel) + ' and press Enter. Type /help for commands, or /demo to see the screen without using any Claude usage.');
});
