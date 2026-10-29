'use strict';
// The cluster engine: runs six headless Claude Code sessions (C1–C6), reads
// their live event streams, and hosts the local "hub" that the agents' cluster
// tools (mcp-bridge.js) and file guard hook (hook-guard.js) talk to.

const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { EventEmitter } = require('events');

const IDS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];
const SQL_RE = /\b(select\s[\s\S]+?\sfrom|insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+(table|index|view)|alter\s+table|drop\s+table)\b|\b(sqlite3|psql|mysql|sqlcmd|invoke-sqlcmd)\b/i;

const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n… (+${s.length - n} chars)` : s;
};

const WIN = process.platform === 'win32';
const HOME = os.homedir();

const DEFAULTS = {
  workspace: '',
  theme: 'cluster',
  model: '',
  permissionMode: 'auto',
  auth: 'subscription',
  compactAtTokens: 120000,
  maxHelpers: 1,
  maxHelpersWhenInstructed: 3,
  maxChainDepth: 3,
  helpTimeoutMinutes: 60,
};

// First existing file from the list, else the first match on the PATH.
// On Windows, PATH matches without .exe/.cmd (npm's shell shims) can't be started directly, so skip them.
function findExe(candidates, name) {
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  if (!name) return null;
  try {
    const out = WIN
      ? execFileSync('where', [name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      : execFileSync(process.env.SHELL || '/bin/sh', ['-lc', `command -v ${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const hits = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return (WIN ? hits.find(h => /\.(exe|cmd|bat)$/i.test(h)) : hits.find(h => h.startsWith('/'))) || null;
  } catch {
    return null;
  }
}

// Claude Code installed with npm on Windows is a .cmd shim, which can't be started without a shell
// (and a shell would mangle the long system prompt). Run its real program instead.
function resolveClaude(p) {
  if (!p) return null;
  if (!/\.(cmd|bat)$/i.test(p)) return { cmd: p, pre: [] };
  const pkg = path.join(path.dirname(p), 'node_modules', '@anthropic-ai', 'claude-code');
  for (const exe of [path.join('bin', 'claude.exe'), 'claude.exe']) {
    if (fs.existsSync(path.join(pkg, exe))) return { cmd: path.join(pkg, exe), pre: [] };
  }
  if (fs.existsSync(path.join(pkg, 'cli.js'))) return { cmd: null, pre: [path.join(pkg, 'cli.js')] };
  return { cmd: p, pre: [], shell: true };
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (WIN) execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-proc.pid, 'SIGTERM'); // the agent runs in its own process group
  } catch {
    try { proc.kill(); } catch {}
  }
}

class Agent {
  constructor(id, cluster) {
    this.id = id;
    this.c = cluster;
    this.proc = null;
    this.clear();
  }

  clear() {
    this.stopping = true;
    killTree(this.proc);
    for (const item of this.queue || []) item.onDone('[session cleared]');
    if (this.current) this.current.onDone('[session cleared]');
    this.proc = null;
    this.sessionId = null;
    this.resumable = false;
    this.busy = false;
    this.current = null;
    this.queue = [];
    this.tasks = [];
    this.ctx = 0;
    this.used = 0;
    this.msgUsage = new Map();
    this.connected = new Set();
    this.waitingOn = new Set();
    this.helpers = 0;
    this.compacting = false;
    this.compactQueued = false;
    this.compacts = 0;
    this.lastText = '';
    this.buf = '';
    this.stderr = '';
  }

  status() {
    if (this.compacting) return 'COMPACTING';
    if (this.busy && this.waitingOn.size) return 'AWAITING ' + [...this.waitingOn].join(',');
    if (this.busy) return 'WORKING';
    if (this.queue.length) return 'QUEUED';
    return this.proc ? 'STANDBY' : 'IDLE';
  }

  watchText() {
    const t = this.c.cfg.compactAtTokens;
    let s = 'NOMINAL';
    if (this.compacting) s = 'COMPACTING CONTEXT';
    else if (this.compactQueued) s = 'COMPACT QUEUED';
    else if (this.ctx >= t * 0.7) s = 'CONTEXT HIGH';
    return this.compacts ? `${s} · ${this.compacts}× COMPACTED` : s;
  }

  snapshot() {
    return {
      id: this.id,
      status: this.status(),
      busy: this.busy,
      tasks: this.tasks.map(t => ({ ...t })),
      ctx: this.ctx,
      used: this.used,
      connected: [...this.connected],
      watch: this.watchText(),
      queued: this.queue.length,
    };
  }

  // Queue a message for this agent. Resolves with its final reply for that turn.
  send(text, opts = {}) {
    return new Promise(resolve => {
      this.queue.push({ text, chain: opts.chain || [], origin: opts.origin || null, internal: !!opts.internal, onDone: resolve });
      this.pump();
      this.c.emitAgent(this);
    });
  }

  pump() {
    if (this.busy || !this.queue.length) return;
    const item = this.queue.shift();
    this.current = item;
    this.busy = true;
    if (item.internal) this.compacting = true;
    try {
      this.ensureProc();
      this.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: item.text } }) + '\n');
    } catch (e) {
      this.c.sys(this.id, 'Could not start Claude Code: ' + e.message);
      this.finishTurn('[error: ' + e.message + ']');
    }
    this.c.emitAgent(this);
  }

  ensureProc() {
    if (this.proc) return;
    const c = this.c, cfg = c.cfg;
    if (c.setupProblems().length) c.findTools();
    const missing = c.setupProblems();
    if (missing.length) throw new Error('setup needed.\n' + missing.join('\n'));
    if (!this.sessionId) this.sessionId = crypto.randomUUID();
    const files = c.writeAgentFiles(this);
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', cfg.permissionMode,
      '--mcp-config', files.mcp,
      '--settings', files.settings,
      '--append-system-prompt', c.systemPrompt(this),
      '--allowedTools', 'mcp__cluster__*',
      ...(this.resumable ? ['--resume', this.sessionId] : ['--session-id', this.sessionId]),
    ];
    if (cfg.model) args.push('--model', cfg.model);
    const env = {
      ...process.env,
      ...c.node.env,
      CT_AGENT: this.id,
      CT_PORT: String(c.port),
      CT_TOKEN: c.token,
      MCP_TOOL_TIMEOUT: String(cfg.helpTimeoutMinutes * 60000),
      ENABLE_TOOL_SEARCH: 'false',
    };
    if (c.gitBash) env.CLAUDE_CODE_GIT_BASH_PATH = c.gitBash;
    // "subscription" uses the claude.ai sign-in instead of a pay-per-use API key.
    if (cfg.auth === 'subscription') delete env.ANTHROPIC_API_KEY;
    const cl = c.claude;
    // With npm's cli.js, Claude Code runs on the same Node the cluster tools use.
    const cmd = cl.cmd || c.node.cmd;
    const p = spawn(cmd, [...cl.pre, ...args], { cwd: c.workspace, env, windowsHide: true, detached: !WIN, shell: !!cl.shell });
    this.proc = p;
    this.resumable = true;
    this.stopping = false;
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', d => this.onData(d));
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-2000); });
    p.on('error', err => this.c.sys(this.id, 'Could not start Claude Code: ' + err.message));
    p.on('exit', code => this.onExit(p, code));
  }

  onExit(p, code) {
    if (p !== this.proc) return;
    this.proc = null;
    if (!this.stopping && code) {
      const tail = this.stderr.trim().split(/\r?\n/).slice(-4).join('\n');
      this.c.sys(this.id, `Claude Code exited (code ${code}).${tail ? '\n' + tail : ''}`);
    }
    this.stopping = false;
    if (this.busy) this.finishTurn('[process ended]');
    this.c.emitAgent(this);
  }

  // Halt: kill the process but keep the session so the next message resumes it.
  stop() {
    this.stopping = true;
    for (const item of this.queue) item.onDone('[halted by operator]');
    this.queue = [];
    killTree(this.proc);
  }

  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      this.handle(ev);
    }
  }

  addUsage(id, u) {
    const prev = this.msgUsage.get(id) || { i: 0, o: 0, c: 0 };
    const cur = {
      i: Math.max(prev.i, u.input_tokens || 0),
      o: Math.max(prev.o, u.output_tokens || 0),
      c: Math.max(prev.c, u.cache_creation_input_tokens || 0),
    };
    this.used += (cur.i - prev.i) + (cur.o - prev.o) + (cur.c - prev.c);
    this.msgUsage.set(id, cur);
    this.ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
  }

  handle(ev) {
    const c = this.c;
    if (ev.type === 'system') {
      if (ev.subtype === 'compact_boundary') {
        this.compacts++;
        c.feed(this.id, 'sys', '-- context compacted --');
      }
    } else if (ev.type === 'assistant') {
      const m = ev.message || {};
      if (m.usage && m.id) this.addUsage(m.id, m.usage);
      for (const b of m.content || []) {
        if (b.type === 'text' && b.text.trim()) {
          this.lastText = b.text;
          if (!this.current?.internal) c.chat(this.id, 'agent', b.text);
        } else if (b.type === 'tool_use') {
          c.toolFeed(this, b);
        }
      }
      c.emitAgent(this);
    } else if (ev.type === 'user') {
      const content = ev.message?.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type !== 'tool_result') continue;
        const raw = typeof b.content === 'string' ? b.content
          : (b.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
        const lines = raw.trim().split(/\r?\n/).slice(0, 4).join('\n');
        if (lines) c.feed(this.id, b.is_error ? 'err' : 'out', clip(lines, 300));
      }
    } else if (ev.type === 'result') {
      this.finishTurn(typeof ev.result === 'string' && ev.result ? ev.result : this.lastText);
    }
  }

  finishTurn(text) {
    const item = this.current;
    this.current = null;
    this.busy = false;
    if (item?.internal) {
      this.compacting = false;
      this.compactQueued = false;
      if (!this.compacts) this.compacts = 1;
      this.ctx = 0;
      this.c.feed(this.id, 'sys', '-- watchdog: compaction complete --');
    }
    this.msgUsage.clear();
    this.lastText = '';
    this.c.releaseAll(this.id);
    if (item && !item.internal) this.c.emit('turn', { id: this.id });
    if (item) item.onDone(text || '(no reply)');
    if (this.compactQueued && !this.compacting) this.queue.unshift(this.c.compactItem());
    this.pump();
    this.c.emitAgent(this);
  }
}

class Cluster extends EventEmitter {
  // appDir: where the app's code is. dataDir: a writable folder for settings and saved sessions.
  constructor(appDir, dataDir) {
    super();
    this.appDir = appDir;
    // Outside programs (Node, Claude Code) can't read inside app.asar, so the two helper scripts are unpacked next to it.
    this.scriptDir = appDir.replace(/app\.asar$/, 'app.asar.unpacked');
    this.runtimeDir = path.join(dataDir, 'runtime');
    this.cfgPath = path.join(dataDir, 'config.json');
    fs.mkdirSync(dataDir, { recursive: true });
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.cfgPath, 'utf8')); } catch {}
    this.cfg = { ...DEFAULTS, ...saved };
    if (!fs.existsSync(this.cfgPath)) this.saveCfg();
    this.workspace = this.cfg.workspace || path.join(HOME, 'Documents', 'Cluster Terminal Projects');
    fs.mkdirSync(this.workspace, { recursive: true });
    this.mode = 'individual';
    this.focusLit = false;
    this.claims = new Map();
    this.linkRefs = new Map();
    this.seq = 0;
    this.token = crypto.randomBytes(16).toString('hex');
    this.findTools();
    this.agents = Object.fromEntries(IDS.map(id => [id, new Agent(id, this)]));
    this.log = [];
    this.feedLog = Object.fromEntries(IDS.map(id => [id, []]));
    this.statePath = path.join(this.runtimeDir, 'state.json');
    this.load();
  }

  // Look for Claude Code, Node.js and (on Windows) Git Bash. Run again before starting an agent,
  // so installing a missing program works without restarting the app.
  findTools() {
    // Apps opened from the Mac Dock or a Linux menu get a bare PATH; borrow the login shell's.
    if (!WIN && !this.pathFixed) {
      this.pathFixed = true;
      try {
        const p = execFileSync(process.env.SHELL || '/bin/sh', ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
        if (p) process.env.PATH = [...new Set([...p.split(':'), ...(process.env.PATH || '').split(':')])].filter(Boolean).join(':');
      } catch {}
    }
    this.claudePath = process.env.CT_CLAUDE || findExe(WIN
      ? [path.join(HOME, '.local', 'bin', 'claude.exe')]
      : [path.join(HOME, '.local', 'bin', 'claude'), path.join(HOME, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'], 'claude');
    this.claude = resolveClaude(this.claudePath);
    const nodePath = findExe(WIN
      ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe')]
      : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'], 'node');
    // Fall back to Electron's own copy of Node if Node.js isn't installed.
    this.node = nodePath ? { cmd: nodePath, env: {} } : { cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
    // Claude Code on Windows needs Git Bash (it runs hooks and shell commands through it).
    this.gitBash = !WIN ? null : process.env.CLAUDE_CODE_GIT_BASH_PATH || findExe([
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
    ], null);
  }

  // Plain-language list of what's missing before the agents can run (empty when ready).
  setupProblems() {
    const out = [];
    if (!this.claude) out.push('Claude Code is not installed (or not found). Install it from https://claude.com/claude-code, open a terminal, run "claude" once and sign in. Then send your message again.');
    if (WIN && !this.gitBash) out.push('Git for Windows is not installed. Claude Code needs it on Windows. Install it from https://git-scm.com/download/win, then send your message again.');
    return out;
  }

  // ---- memory between app launches: sessions, task lists, chat and recent feed ----
  load() {
    let st;
    try { st = JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch { return; }
    if (st.workspace !== this.workspace) return;
    this.mode = st.mode === 'focus' ? 'focus' : 'individual';
    for (const [id, s] of Object.entries(st.agents || {})) {
      const a = this.agents[id];
      if (!a || !s.sessionId) continue;
      a.sessionId = s.sessionId;
      a.resumable = true;
      a.used = s.used || 0;
      a.tasks = s.tasks || [];
      a.compacts = s.compacts || 0;
    }
    this.log = st.chats || [];
    this.seq = this.log.reduce((m, c) => Math.max(m, c.seq || 0), 0);
    for (const id of IDS) this.feedLog[id] = st.feeds?.[id] || [];
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 1000);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    const agents = {};
    for (const a of Object.values(this.agents)) {
      if (a.resumable) agents[a.id] = { sessionId: a.sessionId, used: a.used, tasks: a.tasks, compacts: a.compacts };
    }
    try {
      fs.mkdirSync(this.runtimeDir, { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify({ workspace: this.workspace, mode: this.mode, agents, chats: this.log, feeds: this.feedLog }));
    } catch {}
  }

  async start() {
    await new Promise(res => {
      this.server = http.createServer((req, rsp) => {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', async () => {
          let out;
          try {
            const msg = JSON.parse(body);
            if (msg.token !== this.token) throw new Error('bad token');
            out = await this.rpc(msg.agent, msg.method, msg.params || {});
          } catch (e) {
            out = { error: e.message };
          }
          rsp.writeHead(200, { 'Content-Type': 'application/json' });
          rsp.end(JSON.stringify(out));
        });
      });
      // ask_agent / dispatch hold the request open until the helper replies.
      this.server.requestTimeout = 0;
      this.server.timeout = 0;
      this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; res(); });
    });
    this.watchdog = setInterval(() => this.watch(), 4000);
  }

  shutdown() {
    this.saveNow();
    clearInterval(this.watchdog);
    for (const a of Object.values(this.agents)) { a.stopping = true; killTree(a.proc); }
    this.server?.close();
  }

  state() {
    return {
      agents: Object.values(this.agents).map(a => a.snapshot()),
      mode: this.mode,
      focusLit: this.focusLit,
      workspace: this.workspace,
      cfg: this.cfg,
      demo: false,
      chats: this.log,
      feeds: this.feedLog,
    };
  }

  saveCfg() {
    fs.writeFileSync(this.cfgPath, JSON.stringify(this.cfg, null, 2) + '\n');
  }

  // ---- events to the screen ----
  emitAgent(a) { this.emit('agent', a.snapshot()); this.save?.(); }
  chat(id, role, text, from = null) {
    const m = { id, role, text, from, seq: ++this.seq, t: Date.now() };
    this.log.push(m);
    if (this.log.length > 600) this.log.shift();
    this.emit('chat', m);
    this.save();
  }
  sys(id, text) { this.chat(id, 'sys', text); }
  feed(id, kind, text) {
    const e = { id, kind, text, t: Date.now() };
    const arr = this.feedLog[id];
    arr.push(e);
    if (arr.length > 80) arr.shift();
    this.emit('feed', e);
  }

  toolFeed(a, b) {
    const n = b.name, i = b.input || {};
    let kind = 'tool', text;
    if (n === 'Bash' || n === 'PowerShell') {
      text = (n === 'Bash' ? '$ ' : 'PS> ') + (i.command || '');
      kind = SQL_RE.test(i.command || '') ? 'sql' : 'run';
    } else if (n === 'Write') {
      text = `WRITE ${i.file_path}\n${clip(i.content, 2500)}`;
      kind = /\.sql$/i.test(i.file_path || '') ? 'sql' : 'code';
    } else if (n === 'Edit') {
      text = `EDIT ${i.file_path}\n${clip(i.new_string, 2000)}`;
      kind = /\.sql$/i.test(i.file_path || '') ? 'sql' : 'code';
    } else if (n === 'MultiEdit') {
      text = `EDIT ${i.file_path}\n${clip((i.edits || []).map(e => e.new_string).join('\n···\n'), 2000)}`;
      kind = 'code';
    } else if (n === 'NotebookEdit') {
      text = `NOTEBOOK ${i.notebook_path}\n${clip(i.new_source, 2000)}`;
      kind = 'code';
    } else if (n === 'Read' || n === 'Glob' || n === 'Grep') {
      text = `${n.toUpperCase()} ${i.file_path || i.pattern || ''}${i.path ? '  in ' + i.path : ''}`;
      kind = 'io';
    } else if (n.startsWith('mcp__cluster__')) {
      text = `>> ${n.slice(14).toUpperCase()} ${clip(JSON.stringify(i), 300)}`;
      kind = 'net';
    } else {
      const q = i.query || i.sql;
      if (typeof q === 'string' && SQL_RE.test(q)) { text = `${n}\n${clip(q, 2000)}`; kind = 'sql'; }
      else text = `${n.toUpperCase()} ${clip(JSON.stringify(i), 300)}`;
    }
    this.feed(a.id, kind, text);
  }

  setLink(x, y, on) {
    const key = [x, y].sort().join('-');
    const n = (this.linkRefs.get(key) || 0) + (on ? 1 : -1);
    this.linkRefs.set(key, Math.max(0, n));
    this.emit('link', { a: key.slice(0, 2), b: key.slice(3), active: n > 0 });
  }

  // ---- operator actions ----
  userSend(id, text) {
    if (this.mode === 'focus') {
      const lead = this.agents.C1;
      this.chat('C1', 'user', text);
      this.focusLit = true;
      this.emit('focus', { on: true });
      lead.send(this.focusLeadPrompt(text)).then(() => {
        if (!Object.values(this.agents).some(a => a.busy)) { this.focusLit = false; this.emit('focus', { on: false }); }
      });
      return;
    }
    const a = this.agents[id];
    if (!a) return;
    if (text.trim().toLowerCase() === '/clear') {
      // Fresh session for just this agent.
      a.clear();
      this.releaseAll(id);
      this.log = this.log.filter(m => m.id !== id);
      this.feedLog[id] = [];
      this.sys(id, 'Session cleared. Next message starts fresh.');
      this.emit('reset', this.state());
      return;
    }
    this.chat(id, 'user', text);
    a.send(text);
  }

  stop(id) {
    const list = this.mode === 'focus' ? Object.values(this.agents) : [this.agents[id]].filter(Boolean);
    for (const a of list) { a.stop(); this.sys(a.id, 'Halted by operator. The next message resumes this session.'); }
    if (this.mode === 'focus') { this.focusLit = false; this.emit('focus', { on: false }); }
  }

  clearAll() {
    for (const a of Object.values(this.agents)) a.clear();
    this.claims.clear();
    this.linkRefs.clear();
    this.focusLit = false;
    this.log = [];
    for (const id of IDS) this.feedLog[id] = [];
    this.save();
    this.emit('reset', this.state());
  }

  setMode(mode) {
    if (mode !== 'individual' && mode !== 'focus') return;
    this.clearAll();
    this.mode = mode;
    this.save();
    this.emit('reset', this.state());
  }

  setWorkspace(dir) {
    this.clearAll();
    this.workspace = dir;
    this.cfg.workspace = dir;
    this.saveCfg();
    this.emit('reset', this.state());
  }

  // ---- watchdog: compacts agents whose context is piling up, between turns ----
  compactItem() { return { text: '/compact', chain: [], origin: null, internal: true, onDone: () => {} }; }

  watch() {
    for (const a of Object.values(this.agents)) {
      if (!a.proc || a.compacting || a.compactQueued) continue;
      if (a.ctx < this.cfg.compactAtTokens) continue;
      a.compactQueued = true;
      this.feed(a.id, 'sys', `-- watchdog: context at ${a.ctx.toLocaleString()} tokens, compacting --`);
      if (!a.busy) { a.queue.unshift(this.compactItem()); a.pump(); }
      this.emitAgent(a);
    }
  }

  // ---- hub: calls from the agents' cluster tools and guard hook ----
  async rpc(id, method, p) {
    const a = this.agents[id];
    if (!a) throw new Error('unknown agent');
    switch (method) {
      case 'set_tasks':
        a.tasks = (p.tasks || []).map(t => ({ text: String(t), status: 'pending' }));
        this.emitAgent(a);
        return { text: `Task list set (${a.tasks.length} items). Mark each in_progress / completed with update_task.` };
      case 'update_task': {
        const t = a.tasks[(p.index | 0) - 1];
        if (!t) throw new Error(`No task #${p.index}. You have ${a.tasks.length}.`);
        t.status = p.status === 'completed' ? 'completed' : 'in_progress';
        this.emitAgent(a);
        return { text: `Task ${p.index} → ${t.status}` };
      }
      case 'ask_agent': return this.ask(a, p);
      case 'dispatch': return this.dispatch(a, p);
      case 'claim_files': return this.claim(a, p.paths || [], p.cwd);
      case 'release_files':
        for (const f of p.paths || []) {
          const k = this.norm(f, p.cwd);
          if (this.claims.get(k) === a.id) this.claims.delete(k);
        }
        return { text: 'Released.' };
      case 'cluster_status': return { text: this.statusText() };
      case 'guard': return this.guard(a, p);
      default: throw new Error('unknown method ' + method);
    }
  }

  norm(f, cwd) {
    const k = path.resolve(cwd || this.workspace, String(f));
    return WIN || process.platform === 'darwin' ? k.toLowerCase() : k;
  }

  async withLink(a, to, fn) {
    a.waitingOn.add(to.id);
    a.connected.add(to.id);
    to.connected.add(a.id);
    this.setLink(a.id, to.id, true);
    this.emitAgent(a); this.emitAgent(to);
    try {
      return await fn();
    } finally {
      a.waitingOn.delete(to.id);
      a.connected.delete(to.id);
      to.connected.delete(a.id);
      this.setLink(a.id, to.id, false);
      this.emitAgent(a); this.emitAgent(to);
    }
  }

  async ask(a, p) {
    const to = this.agents[String(p.agent || '').toUpperCase()];
    if (!to) throw new Error('Unknown agent. Use C1–C6.');
    if (to === a) throw new Error('You cannot ask yourself.');
    const chain = [...(a.current?.chain || []), a.id];
    if (chain.includes(to.id)) throw new Error(`${to.id} is already in this request chain (${chain.join(' → ')}); asking it would loop.`);
    if (chain.length > this.cfg.maxChainDepth) throw new Error(`This request chain is already ${chain.length} agents deep. Finish the work yourself.`);
    const limit = p.allow_extra ? this.cfg.maxHelpersWhenInstructed : this.cfg.maxHelpers;
    if (a.helpers >= limit) throw new Error(`You already have ${a.helpers} helper(s) working (limit ${limit}).` + (p.allow_extra ? '' : ' Only set allow_extra if the operator explicitly allowed more helpers.'));
    if (to.busy || to.queue.length) throw new Error(`${to.id} is busy with its own work. Check cluster_status for an idle agent, or do it yourself.`);
    a.helpers++;
    try {
      return await this.withLink(a, to, async () => {
        this.chat(to.id, 'peer', p.request, a.id);
        const reply = await to.send(`[REQUEST FROM ${a.id}]\n${p.request}\n\n(Do exactly this, then end your turn with a short report. Your final message is returned to ${a.id}.)`, { chain, origin: a.id });
        return { text: `${to.id} replied:\n${reply}` };
      });
    } finally {
      a.helpers--;
    }
  }

  async dispatch(a, p) {
    if (this.mode !== 'focus') throw new Error('dispatch only works in focus mode. Use ask_agent.');
    if (a.id !== 'C1') throw new Error('Only the lead (C1) can dispatch.');
    const seen = new Set();
    const tasks = (p.tasks || []).filter(t => {
      const id = String(t.agent || '').toUpperCase();
      if (!this.agents[id] || id === 'C1' || seen.has(id)) return false;
      seen.add(id);
      t.agent = id;
      return true;
    });
    if (!tasks.length) throw new Error('No valid tasks. Give each of C2–C6 at most one task.');
    const results = await Promise.all(tasks.map(t => {
      const to = this.agents[t.agent];
      return this.withLink(a, to, async () => {
        this.chat(to.id, 'peer', t.task, 'C1');
        const reply = await to.send(`[FOCUS TASK FROM C1]\n${t.task}\n\n(Work only on this piece and the files it names. End your turn with a short report; it goes back to C1.)`, { chain: ['C1'], origin: 'C1' });
        return `### ${to.id}\n${reply}`;
      });
    }));
    return { text: results.join('\n\n') };
  }

  claim(a, paths, cwd) {
    const got = [], refused = [];
    for (const f of paths) {
      const k = this.norm(f, cwd);
      const owner = this.claims.get(k);
      if (owner && owner !== a.id) refused.push(`${f} (held by ${owner})`);
      else { this.claims.set(k, a.id); got.push(f); }
    }
    return { text: `Claimed: ${got.join(', ') || 'none'}` + (refused.length ? `\nRefused: ${refused.join(', ')}` : '') };
  }

  releaseAll(id) {
    for (const [k, v] of this.claims) if (v === id) this.claims.delete(k);
  }

  guard(a, p) {
    if (p.command) return this.guardShell(a, p.command);
    if (!p.file) return { allow: true };
    const k = this.norm(p.file, p.cwd);
    const owner = this.claims.get(k);
    // A helper may edit files owned by the agent it's working for.
    if (owner && owner !== a.id && !(a.current?.chain || []).includes(owner)) {
      this.feed(a.id, 'err', `!! GUARD: ${path.basename(k)} is claimed by ${owner}`);
      return { allow: false, reason: `${p.file} is claimed by ${owner}, which is working on it. Don't edit it another way (no shell writes). Ask ${owner} with mcp__cluster__ask_agent, wait, or work on something else.` };
    }
    if (!owner) this.claims.set(k, a.id);
    return { allow: true };
  }

  // Shell commands can't be checked exactly, so: refuse a command that mentions a file
  // another agent holds AND looks like it writes, moves or deletes something.
  guardShell(a, cmd) {
    const WRITE_RE = /(^|[^-=<2&])>{1,2}(?!&)|\b(set-content|add-content|out-file|remove-item|move-item|copy-item|rename-item|new-item|tee|truncate|rm|mv|cp|del|erase|ren|rename)\b|\bsed\s+-i|\bgit\s+(checkout|restore|reset|stash|clean|rm|mv)\b/i;
    if (!WRITE_RE.test(cmd)) return { allow: true };
    const low = cmd.toLowerCase();
    for (const [file, owner] of this.claims) {
      if (owner === a.id || (a.current?.chain || []).includes(owner)) continue;
      const base = path.basename(file);
      if (!low.includes(base)) continue;
      this.feed(a.id, 'err', `!! GUARD: shell write touching ${base} (claimed by ${owner})`);
      return { allow: false, reason: `This command looks like it changes ${base}, which ${owner} has claimed. Don't change that file. Ask ${owner} with mcp__cluster__ask_agent, wait, or do other work. (If this is a different file with the same name, use the Edit/Write tools instead.)` };
    }
    return { allow: true };
  }

  statusText() {
    const lines = Object.values(this.agents).map(x => {
      const done = x.tasks.filter(t => t.status === 'completed').length;
      const now = x.tasks.find(t => t.status === 'in_progress');
      return `${x.id}: ${x.status()}${x.tasks.length ? ` — ${done}/${x.tasks.length} tasks` : ''}${now ? ` — now: ${now.text}` : ''}`;
    });
    const claims = [...this.claims].map(([f, o]) => `${o} holds ${f}`);
    return `Mode: ${this.mode}\n${lines.join('\n')}\n\nClaimed files:\n${claims.join('\n') || '(none)'}`;
  }

  // ---- per-agent setup ----
  writeAgentFiles(a) {
    const dir = path.join(this.runtimeDir, a.id);
    fs.mkdirSync(dir, { recursive: true });
    const env = { ...this.node.env, CT_AGENT: a.id, CT_PORT: String(this.port), CT_TOKEN: this.token };
    const mcp = path.join(dir, 'mcp.json');
    fs.writeFileSync(mcp, JSON.stringify({
      mcpServers: { cluster: { type: 'stdio', command: this.node.cmd, args: [path.join(this.scriptDir, 'mcp-bridge.js')], env } },
    }, null, 2));
    const fwd = s => s.replace(/\\/g, '/');
    const settings = path.join(dir, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell',
          hooks: [{ type: 'command', command: `"${fwd(this.node.cmd)}" "${fwd(path.join(this.scriptDir, 'hook-guard.js'))}"`, timeout: 15 }],
        }],
      },
    }, null, 2));
    return { mcp, settings };
  }

  systemPrompt(a) {
    const others = IDS.filter(x => x !== a.id).join(', ');
    const focus = this.mode === 'focus'
      ? (a.id === 'C1'
        ? 'FOCUS MODE: you are the lead. The operator talks only to you. Split work across C2–C6 with mcp__cluster__dispatch, then integrate their results.'
        : 'FOCUS MODE: you are a worker. C1 is the lead and will send you one piece of a shared project. Stay strictly inside that piece.')
      : 'INDIVIDUAL MODE: the operator gives you your own task. Work on it in your own lane.';
    return `You are agent ${a.id} in CLUSTER TERMINAL, a team of six Claude Code agents (C1–C6) sharing one project folder: ${this.workspace}
The other agents are ${others}. ${focus}

Cluster tools (MCP server "cluster"):
- mcp__cluster__set_tasks: for any instruction with more than one step, post a short task list first. Then call mcp__cluster__update_task with status "in_progress" when you start an item and "completed" when it is done. The operator watches this as your progress meter, so keep it accurate.
- mcp__cluster__ask_agent: hand a piece of work to another agent; it waits for their reply. At most ONE helper at a time unless the operator explicitly said you may use more (then pass allow_extra=true). Only ask when it genuinely helps. Make the request self-contained (goal, file paths, what to report back).
- mcp__cluster__cluster_status: see who is busy and which files are claimed.
- mcp__cluster__claim_files / mcp__cluster__release_files: reserve files before editing shared ones.

Rules so agents don't step on each other:
1. Files you edit are claimed by you automatically until your turn ends. If an edit is refused because another agent holds the file, do not work around it (no shell writes to that file). Ask that agent, wait, or do other work.
2. Stay inside your task. Don't reformat, refactor or "tidy" files outside it.
3. Claim shared files (package.json, lockfiles, configs) before editing them.
4. Never run git commands that change other agents' work (reset, checkout of files, stash, clean, rebase, force push).
5. When a message starts with "[REQUEST FROM Cx]" or "[FOCUS TASK FROM C1]", do exactly that and finish with a short report. Your final message is returned to that agent.
6. You run headless: nobody can answer questions mid-turn. If something is unclear, make a sensible choice and say so at the end.`;
  }

  focusLeadPrompt(text) {
    return `[FOCUS MODE — you are the lead]
Operator instruction:
${text}

How to run this:
1. Post your own plan with mcp__cluster__set_tasks.
2. Look at the project just enough to split the work.
3. Split it into up to five independent pieces with no overlapping files. Call mcp__cluster__dispatch ONCE with one piece per agent (C2–C6; use fewer if the job doesn't split that far). Each piece must be self-contained: the goal, the files it owns, and any interfaces it must match.
4. When the results come back, integrate them, fix the seams, check that it works, and report to the operator.`;
  }
}

module.exports = { Cluster, IDS };
