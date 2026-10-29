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
// The orchestrator: a seventh agent that only works in orch mode. It plans, assigns, owns the
// file map, rules on disputes and keeps the project ledger; it never writes code itself.
const ORCH = 'ORCH';
const ALL = [...IDS, ORCH];
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
  orchModel: '',
  orchResetAtTokens: 60000,
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
    clearTimeout(this.interruptTimer);
    this.interrupting = false;
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
    this.code = null;                         // latest code this agent wrote: { file, text, t }
  }

  // New Claude Code session (orch mode: every assignment starts with a clean memory).
  freshSession() {
    if (this.proc) { this.stopping = true; killTree(this.proc); }
    this.proc = null;
    this.sessionId = null;
    this.resumable = false;
    this.ctx = 0;
    this.msgUsage = new Map();
    this.buf = '';
    this.lastText = '';
    this.compactQueued = false;
  }

  role() {
    if (this.c.mode !== 'orch') return 'agent';
    return this.id === ORCH ? 'orch' : 'worker';
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
    return this.compacts ? `${s} · ${this.compacts}× ${this.id === ORCH ? 'RESET' : 'COMPACTED'}` : s;
  }

  snapshot() {
    return {
      id: this.id,
      role: this.role(),
      code: this.code,
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
  // urgent (operator messages): goes to the front of the queue and interrupts the current turn.
  send(text, opts = {}) {
    return new Promise(resolve => {
      // fresh: start a new session first. bundle: hub notices to ORCH, merged while they wait.
      const item = { text, chain: opts.chain || [], origin: opts.origin || null, internal: !!opts.internal, urgent: !!opts.urgent, fresh: !!opts.fresh, bundle: !!opts.bundle, onDone: resolve };
      if (item.urgent) {
        const at = this.queue.findIndex(q => !q.urgent);
        this.queue.splice(at < 0 ? this.queue.length : at, 0, item);
      } else this.queue.push(item);
      this.pump();
      if (item.urgent && this.current !== item) this.interrupt();
      this.c.emitAgent(this);
    });
  }

  // Like Esc in Claude Code: stop the current turn but keep the session, then take the next message.
  interrupt() {
    if (!this.busy || !this.proc || !this.current || this.current.internal || this.interrupting) return;
    this.interrupting = true;
    this.current.interrupted = true;
    this.c.feed(this.id, 'sys', '-- interrupted by operator --');
    try {
      this.proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'interrupt' } }) + '\n');
    } catch {}
    // If Claude Code doesn't stop in time, restart it on the same session.
    this.interruptTimer = setTimeout(() => {
      if (this.interrupting && this.proc) { this.stopping = true; killTree(this.proc); }
    }, 8000);
  }

  pump() {
    if (this.busy || !this.queue.length) return;
    const item = this.queue.shift();
    this.current = item;
    this.busy = true;
    if (item.internal) this.compacting = true;
    // Each new message gets its own task list (but the orchestrator keeps its plan through hub notices).
    else if (item.origin !== 'hub') this.tasks = [];
    this.c.emitAgent(this);
    try {
      if (item.fresh) this.freshSession();
      // A new orchestrator session remembers nothing: brief it from the ledger first.
      if (this.id === ORCH && !this.resumable && !item.internal) item.text = this.c.orchPrimer() + '\n\n' + item.text;
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
    // The orchestrator plans and judges; it can read and run checks but not edit files.
    if (this.id === ORCH) args.push('--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit');
    const model = this.id === ORCH ? (cfg.orchModel || cfg.model) : cfg.model;
    if (model) args.push('--model', model);
    const env = {
      ...process.env,
      ...c.node.env,
      CT_AGENT: this.id,
      CT_MODE: c.mode,
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
    clearTimeout(this.interruptTimer);
    this.interrupting = false;
    if (item?.interrupted) text = '[interrupted by operator before finishing]' + (text ? '\n' + text : '');
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
    this.claims = new Map();
    this.linkRefs = new Map();
    this.seq = 0;
    this.token = crypto.randomBytes(16).toString('hex');
    this.findTools();
    this.agents = Object.fromEntries(ALL.map(id => [id, new Agent(id, this)]));
    this.log = [];
    this.feedLog = Object.fromEntries(ALL.map(id => [id, []]));
    this.statePath = path.join(this.runtimeDir, 'state.json');
    this.resetOrch();
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

  // ---- orch mode state: file ownership, assignments, tickets, mailboxes, ledger ----
  resetOrch() {
    for (const t of this.tickets?.values() || []) t.resolve({ text: '[ticket cancelled: the cluster was reset]' });
    for (const w of this.mailWaiters?.values() || []) w();
    this.owners = new Map();       // normalised path (file, folder or glob) -> owning worker; lasts across turns
    this.assignments = new Map();  // worker -> { task, owns, t, took }
    this.tickets = new Map();      // ticket number -> { id, from, kind, summary, agents, resolve, t }
    this.ticketSeq = 0;
    this.mail = Object.fromEntries(ALL.map(id => [id, []]));
    this.mailWaiters = new Map();
    this.comms = [];               // agent-to-agent traffic the orchestrator can look through
    this.ledger = {};              // section -> text; written to <project>/.cluster/ledger.md
  }

  // ---- memory between app launches: sessions, task lists, chat and recent feed ----
  load() {
    let st;
    try { st = JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch { return; }
    if (st.workspace !== this.workspace) return;
    this.mode = st.mode === 'orch' || st.mode === 'focus' ? 'orch' : 'individual';
    if (st.orch) {
      this.owners = new Map(st.orch.owners || []);
      this.ledger = st.orch.ledger || {};
    }
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
    for (const id of ALL) this.feedLog[id] = st.feeds?.[id] || [];
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
      const orch = { owners: [...this.owners], ledger: this.ledger };
      fs.writeFileSync(this.statePath, JSON.stringify({ workspace: this.workspace, mode: this.mode, agents, chats: this.log, feeds: this.feedLog, orch }));
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

  // The orchestrator only counts in orch mode.
  activeAgents() { return Object.values(this.agents).filter(x => x.id !== ORCH || this.mode === 'orch'); }

  // ---- events to the screen ----
  emitAgent(a) { this.emit('agent', a.snapshot()); this.save?.(); }
  // kind (role 'peer'): request (ask_agent), assign, message, escalate, ruling.
  chat(id, role, text, from = null, kind = null) {
    const m = { id, role, text, from, seq: ++this.seq, t: Date.now() };
    if (kind) m.kind = kind;
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
    // The agent's box shows the code it is writing.
    const written = { Write: i.content, Edit: i.new_string, MultiEdit: (i.edits || []).map(e => e.new_string).join('\n'), NotebookEdit: i.new_source }[n];
    if (typeof written === 'string' && written) {
      a.code = { file: i.file_path || i.notebook_path || '', text: written.slice(0, 6000), t: Date.now() };
    }
    this.feed(a.id, kind, text);
  }

  setLink(x, y, on) {
    const [p, q] = [x, y].sort();
    const key = p + '-' + q;
    const n = (this.linkRefs.get(key) || 0) + (on ? 1 : -1);
    this.linkRefs.set(key, Math.max(0, n));
    this.emit('link', { a: p, b: q, active: n > 0 });
  }

  // ---- operator actions ----
  userSend(id, text) {
    // Orch mode: the operator talks only to the orchestrator.
    if (this.mode === 'orch') id = ORCH;
    else if (id === ORCH) return;
    const a = this.agents[id];
    if (!a) return;
    if (id === ORCH && text.trim().toLowerCase() === '/clear') {
      // Fresh memory for the orchestrator; it reloads from the ledger. Work in progress carries on.
      a.freshSession();
      a.tasks = [];
      this.sys(ORCH, 'Orchestrator memory cleared. It reloads from the ledger on the next message.');
      this.emitAgent(a);
      return;
    }
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
    a.send(text, { urgent: true });
  }

  stop(id) {
    // Orch mode: HALT stops the whole cluster; open tickets and assignments are dropped.
    const list = this.mode === 'orch' ? Object.values(this.agents) : [this.agents[id]].filter(Boolean);
    for (const a of list) {
      const was = a.busy || a.queue.length;
      a.stop();
      if (was || this.mode !== 'orch') this.sys(a.id, 'Halted by operator. The next message resumes this session.');
    }
    if (this.mode === 'orch') {
      for (const t of this.tickets.values()) t.resolve({ text: '[halted by operator]' });
      this.tickets.clear();
      for (const w of this.assignments.keys()) this.setLink(ORCH, w, false);
      this.assignments.clear();
    }
  }

  clearAll() {
    for (const a of Object.values(this.agents)) a.clear();
    this.claims.clear();
    this.linkRefs.clear();
    this.resetOrch();
    this.log = [];
    for (const id of ALL) this.feedLog[id] = [];
    this.save();
    this.emit('reset', this.state());
  }

  setMode(mode) {
    if (mode === 'focus') mode = 'orch';
    if (mode !== 'individual' && mode !== 'orch') return;
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
      if (a.id === ORCH) {
        // The orchestrator isn't compacted: between turns it gets a fresh memory and reloads from the ledger.
        if (this.mode !== 'orch' || !a.proc || a.busy || a.queue.length || a.ctx < (this.cfg.orchResetAtTokens || 60000)) continue;
        this.feed(ORCH, 'sys', `-- watchdog: orchestrator at ${a.ctx.toLocaleString()} tokens; fresh memory, reloads from the ledger --`);
        a.freshSession();
        a.compacts++;
        this.emitAgent(a);
        continue;
      }
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
    const out = await this.rpcCall(a, method, p);
    // Workers hear about unread messages on their next cluster tool call.
    const unread = this.mail[a.id]?.length;
    if (unread && out?.text !== undefined && method !== 'read_messages' && a.id !== ORCH) {
      out.text += `\n\n[You have ${unread} unread message(s) from other agents. Call mcp__cluster__read_messages.]`;
    }
    return out;
  }

  async rpcCall(a, method, p) {
    const orch = this.mode === 'orch';
    const orchOnly = () => { if (!orch || a.id !== ORCH) throw new Error(`${method} is for the orchestrator in orch mode only.`); };
    const workerOnly = () => { if (!orch || a.id === ORCH) throw new Error(`${method} is for workers in orch mode only.`); };
    switch (method) {
      case 'assign': orchOnly(); return this.assign(a, p);
      case 'rule': orchOnly(); return this.rule(p);
      case 'ledger_read': orchOnly(); return { text: this.ledgerText() };
      case 'ledger_write': orchOnly(); return this.ledgerWrite(p);
      case 'set_ownership': orchOnly(); return this.setOwnership(p);
      case 'comms_log': orchOnly(); return { text: this.comms.slice(-Math.max(1, Math.min(200, p.last | 0 || 30))).map(c => `[${new Date(c.t).toTimeString().slice(0, 8)}] ${c.from} > ${c.to} (${c.kind}): ${c.text}`).join('\n') || '(no traffic yet)' };
      case 'escalate': workerOnly(); return this.escalate(a, p);
      case 'read_messages': workerOnly(); return this.readMessages(a, p);
      case 'message_agent': if (!orch) throw new Error('message_agent works in orch mode. Use ask_agent.'); return this.messageAgent(a, p);
    }
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
      case 'ask_agent':
        if (orch) throw new Error('In orch mode, use message_agent for a neighbour or escalate to the orchestrator.');
        return this.ask(a, p);
      case 'claim_files': return this.claim(a, p.paths || [], p.cwd);
      case 'release_files':
        for (const f of p.paths || []) {
          const k = this.norm(f, p.cwd);
          if (this.claims.get(k) === a.id) this.claims.delete(k);
        }
        return { text: 'Released.' };
      case 'cluster_status': return { text: orch ? this.orchStatusText() : this.statusText() };
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

  // ---- orch mode: the orchestrator's hub methods ----

  // Hand work to workers. Doesn't wait: each worker's report comes back to the orchestrator
  // as a new message, so it stays free to rule on tickets and answer the operator meanwhile.
  assign(o, p) {
    const done = [], refused = [];
    for (const t of p.tasks || []) {
      const id = String(t.agent || '').toUpperCase();
      const w = this.agents[id];
      if (!IDS.includes(id)) { refused.push(`${t.agent}: not a worker (C1–C6)`); continue; }
      if (w.busy || w.queue.length || this.assignments.has(id)) { refused.push(`${id}: busy with "${this.assignments.get(id)?.task.slice(0, 60) || 'other work'}"`); continue; }
      const owns = (t.owns || []).map(String);
      const clash = this.ownershipClash(id, owns);
      if (clash) { refused.push(`${id}: ${clash}`); continue; }
      for (const [k, v] of this.owners) if (v === id) this.owners.delete(k);
      for (const f of owns) this.owners.set(this.norm(f), id);
      const job = { task: String(t.task || ''), owns, t: Date.now(), took: [] };
      this.assignments.set(id, job);
      this.chat(id, 'peer', job.task, ORCH, 'assign');
      this.logComms(ORCH, id, 'assign', job.task);
      w.connected.add(ORCH); o.connected.add(id);
      this.setLink(ORCH, id, true);
      done.push({ w, job, t });
    }
    // Brief after recording every assignment, so each briefing lists all of its neighbours.
    for (const { w, job, t } of done) {
      w.send(this.briefing(w, job, t.context), { chain: [ORCH], origin: ORCH, fresh: t.fresh !== false })
        .then(reply => this.onReport(w, job, reply));
    }
    this.writeLedger();
    this.emitAgent(o);
    let text = done.length ? `Assigned: ${done.map(d => d.w.id).join(', ')}. Their reports come to you as new messages ([REPORT FROM Cx]). Don't wait or poll; end your turn unless you have more to assign.` : 'Nothing assigned.';
    if (refused.length) text += `\nRefused:\n- ${refused.join('\n- ')}`;
    return { text };
  }

  briefing(w, job, context) {
    const others = [...this.assignments].filter(([id]) => id !== w.id)
      .map(([id, j]) => `- ${id}: ${j.task.split('\n')[0].slice(0, 120)} (owns: ${j.owns.join(', ') || 'nothing yet'})`);
    const keep = ['Goal', 'Contracts', 'Decisions'].filter(s => this.ledger[s]).map(s => `## ${s}\n${this.ledger[s]}`).join('\n\n');
    return `[ASSIGNMENT FROM ORCH]
${job.task}

Files you own (only you may edit them): ${job.owns.join(', ') || '(none listed; unowned files you edit become yours)'}
${context ? `\nContext from the orchestrator:\n${context}\n` : ''}
Other workers right now:
${others.join('\n') || '(none)'}
${keep ? `\nFrom the project ledger (binding):\n${keep}\n` : ''}
You start with a fresh memory; everything you need is above or in the files. When you finish, end with:
REPORT
Done: <one or two lines>
Changed files: <list>
Decisions I made: <short list, or none>
Contract impact: <none, or what changed and who is affected>
Concerns / follow-ups: <short list, or none>`;
  }

  onReport(w, job, reply) {
    if (this.assignments.get(w.id) !== job) return;   // halted or reset meanwhile
    this.assignments.delete(w.id);
    w.connected.delete(ORCH); this.agents[ORCH].connected.delete(w.id);
    this.setLink(ORCH, w.id, false);
    this.logComms(w.id, ORCH, 'report', reply);
    const took = job.took.length ? `\n(${w.id} also took ownership of: ${job.took.join(', ')})` : '';
    const left = this.assignments.size;
    let text = `[REPORT FROM ${w.id}] task: ${job.task.split('\n')[0].slice(0, 120)}\n${reply}${took}\n\n(${left ? `${left} assignment(s) still running: ${[...this.assignments.keys()].join(', ')}.` : 'No assignments are running now.'})`;
    this.notifyOrch(text);
    this.writeLedger();
    this.emitAgent(w);
  }

  // Hub notices to the orchestrator. Notices that arrive while it's busy are merged into one message.
  notifyOrch(text) {
    const o = this.agents[ORCH];
    const waiting = o.queue.find(i => i.bundle);
    if (waiting) { waiting.text += '\n\n---\n\n' + text; return; }
    o.send(text, { bundle: true, origin: 'hub' });
  }

  ownershipClash(id, paths) {
    for (const f of paths) {
      const k = this.norm(f);
      for (const [key, owner] of this.owners) {
        if (owner === id || !this.assignments.has(owner)) continue;   // an idle worker's files can move
        if (key === k || this.ownerMatch(key, k) || this.ownerMatch(k, key)) return `${f} overlaps ${owner}'s files while ${owner} is working`;
      }
    }
    return null;
  }

  // Does owned entry `key` (a file, folder or glob) cover the file `k`?
  ownerMatch(key, k) {
    if (key === k) return true;
    if (key.includes('*')) {
      const re = new RegExp('^' + key.replace(/[.+?^${}()|[\]\\]/g, m => m === '\\' ? '[\\\\/]' : '\\' + m).replace(/\*\*/g, '\u0000').replace(/\*/g, '[^\\\\/]*').replace(/\u0000/g, '.*') + '$');
      return re.test(k);
    }
    return k.startsWith(key.endsWith(path.sep) ? key : key + path.sep);
  }

  ownerOf(k) {
    let best = null, len = -1;
    for (const [key, owner] of this.owners) if (this.ownerMatch(key, k) && key.length > len) { best = owner; len = key.length; }
    return best;
  }

  setOwnership(p) {
    const id = String(p.agent || '').toUpperCase();
    if (!IDS.includes(id)) throw new Error('agent must be one of C1–C6');
    const paths = (p.paths || []).map(String);
    const mode = p.mode || 'replace';
    if (mode !== 'remove') {
      const clash = this.ownershipClash(id, paths);
      if (clash) throw new Error(clash);
    }
    if (mode === 'replace') for (const [k, v] of this.owners) if (v === id) this.owners.delete(k);
    for (const f of paths) {
      const k = this.norm(f);
      if (mode === 'remove') { if (this.owners.get(k) === id) this.owners.delete(k); } else this.owners.set(k, id);
    }
    this.writeLedger();
    return { text: `${id} now owns: ${[...this.owners].filter(([, v]) => v === id).map(([k]) => k).join(', ') || 'nothing'}` };
  }

  // A worker asks the orchestrator to decide (dispute, contract change, files, question) and waits for the ruling.
  escalate(a, p) {
    const id = ++this.ticketSeq;
    const kind = ['dispute', 'change', 'files', 'question'].includes(p.kind) ? p.kind : 'question';
    const agents = (p.agents || []).map(x => String(x).toUpperCase()).filter(x => IDS.includes(x) && x !== a.id);
    const files = (p.files || []).map(String);
    const summary = String(p.summary || '').trim();
    if (!summary) throw new Error('summary is required: what you need decided, the options, and your recommendation.');
    this.chat(ORCH, 'peer', `#${id} ${kind.toUpperCase()}: ${summary}`, a.id, 'escalate');
    this.logComms(a.id, ORCH, 'escalate', `#${id} ${kind}: ${summary}`);
    a.waitingOn.add(ORCH);
    this.setLink(a.id, ORCH, true);
    this.emitAgent(a);
    return new Promise(resolve => {
      const ticket = { id, from: a.id, kind, summary, agents, files, t: Date.now() };
      const finish = r => {
        if (!this.tickets.has(id)) return;
        this.tickets.delete(id);
        clearTimeout(ticket.timer);
        a.waitingOn.delete(ORCH);
        this.setLink(a.id, ORCH, false);
        this.emitAgent(a);
        resolve(r);
      };
      ticket.resolve = finish;
      ticket.timer = setTimeout(() => finish({ text: 'No ruling arrived in time. Use your best judgment, stay inside your contracts, and flag it in your report.' }), this.cfg.helpTimeoutMinutes * 60000);
      this.tickets.set(id, ticket);
      this.notifyOrch(`[TICKET #${id} · ${kind.toUpperCase()} FROM ${a.id}${agents.length ? ` · involves ${agents.join(', ')}` : ''}${files.length ? ` · files: ${files.join(', ')}` : ''}]\n${summary}\n\n${a.id} is paused until you answer with mcp__cluster__rule (ticket ${id}).`);
    });
  }

  rule(p) {
    const t = this.tickets.get(p.ticket | 0);
    if (!t) throw new Error(`No open ticket #${p.ticket}. Open: ${[...this.tickets.keys()].join(', ') || 'none'}`);
    const decision = String(p.decision || '').trim();
    if (!decision) throw new Error('decision is required.');
    const granted = [];
    for (const f of p.grant_files || []) { this.owners.set(this.norm(f), t.from); granted.push(f); }
    const line = `- #${t.id} (${t.from} ${t.kind}${t.agents.length ? ' with ' + t.agents.join(', ') : ''}): ${decision}`;
    this.ledger.Decisions = (this.ledger.Decisions ? this.ledger.Decisions + '\n' : '') + line;
    this.chat(t.from, 'peer', decision, ORCH, 'ruling');
    this.logComms(ORCH, t.from, 'ruling', `#${t.id}: ${decision}`);
    // Everyone involved hears the ruling.
    for (const x of t.agents) this.deliver(ORCH, x, `Ruling on ticket #${t.id} (raised by ${t.from}): ${decision}`, 'ruling');
    t.resolve({ text: `ORCH RULING on #${t.id}: ${decision}${granted.length ? `\nYou now own: ${granted.join(', ')}` : ''}\n(This is recorded in the ledger. Carry on.)` });
    this.writeLedger();
    return { text: `Ruled on #${t.id}; ${t.from} resumes${t.agents.length ? `, ${t.agents.join(', ')} notified` : ''}. Recorded under Decisions.` };
  }

  messageAgent(a, p) {
    const to = String(p.agent || '').toUpperCase();
    const text = String(p.message || '').trim();
    if (!text) throw new Error('message is required.');
    if (to === a.id) throw new Error('You cannot message yourself.');
    if (to === ORCH) {
      this.chat(ORCH, 'peer', text, a.id, 'message');
      this.logComms(a.id, ORCH, 'message', text);
      this.notifyOrch(`[MESSAGE FROM ${a.id}]\n${text}`);
      return { text: 'Sent to the orchestrator. If you need a decision before you can go on, use escalate instead (it waits for the answer).' };
    }
    if (!IDS.includes(to)) throw new Error('agent must be C1–C6 or ORCH.');
    this.deliver(a.id, to, text, 'message');
    const w = this.agents[to];
    const idle = !w.busy && !w.queue.length;
    return { text: idle
      ? `${to} is not working right now, so it will only see this on its next assignment. If you need an answer, escalate to the orchestrator.`
      : `Delivered to ${to}; it reads messages between steps. To wait for its answer, call read_messages with wait_seconds.` };
  }

  deliver(from, to, text, kind) {
    this.mail[to].push({ from, text, kind, t: Date.now() });
    if (from !== ORCH || kind !== 'ruling') this.chat(to, 'peer', text, from, kind);
    if (kind === 'message') this.logComms(from, to, kind, text);
    this.setLink(from, to, true);
    setTimeout(() => this.setLink(from, to, false), 5000);
    this.mailWaiters.get(to)?.();
  }

  async readMessages(a, p) {
    const wait = Math.max(0, Math.min(180, Number(p.wait_seconds) || 0));
    if (!this.mail[a.id].length && wait) {
      await new Promise(res => {
        const done = () => { clearTimeout(timer); this.mailWaiters.delete(a.id); res(); };
        const timer = setTimeout(done, wait * 1000);
        this.mailWaiters.set(a.id, done);
      });
    }
    const box = this.mail[a.id].splice(0);
    if (!box.length) return { text: 'No messages.' };
    return { text: box.map(m => `From ${m.from} (${m.kind}): ${m.text}`).join('\n\n') };
  }

  logComms(from, to, kind, text) {
    this.comms.push({ from, to, kind, text: clip(text, 1500), t: Date.now() });
    if (this.comms.length > 400) this.comms.shift();
  }

  // ---- the ledger: the orchestrator's long-term memory, kept in the project as .cluster/ledger.md ----
  ledgerWrite(p) {
    const section = String(p.section || '').trim();
    if (!section) throw new Error('section is required (e.g. Goal, Plan, Contracts, Decisions, Open questions).');
    if (/^(ownership|assignments|open tickets)$/i.test(section)) throw new Error(`${section} is kept automatically.`);
    const text = String(p.text ?? '').trim();
    if (p.mode === 'append' && this.ledger[section]) this.ledger[section] += '\n' + text;
    else if (text) this.ledger[section] = text;
    else delete this.ledger[section];
    this.writeLedger();
    return { text: `Ledger section "${section}" saved (${(this.ledger[section] || '').length} chars). Keep it short: outcomes and pointers, not code.` };
  }

  ledgerText() {
    const order = ['Goal', 'Plan', 'Contracts', 'Decisions', 'Open questions'];
    const names = [...order.filter(s => this.ledger[s]), ...Object.keys(this.ledger).filter(s => !order.includes(s))];
    const rel = k => (k.startsWith(this.workspace.toLowerCase()) ? path.relative(this.workspace.toLowerCase(), k) : k) || '.';
    const own = {};
    for (const [k, v] of this.owners) (own[v] ||= []).push(rel(k));
    return `# Cluster ledger
Kept by the orchestrator (ORCH). Workers start every assignment with a fresh memory; this file is the project's memory.
${names.map(s => `\n## ${s}\n${this.ledger[s]}`).join('\n')}

## Ownership (automatic)
${Object.entries(own).sort().map(([id, fs]) => `- ${id}: ${fs.join(', ')}`).join('\n') || '- (none)'}

## Assignments running (automatic)
${[...this.assignments].map(([id, j]) => `- ${id}: ${j.task.split('\n')[0].slice(0, 160)}`).join('\n') || '- (none)'}

## Open tickets (automatic)
${[...this.tickets.values()].map(t => `- #${t.id} ${t.kind} from ${t.from}: ${t.summary.slice(0, 200)}`).join('\n') || '- (none)'}
`;
  }

  writeLedger() {
    if (this.mode !== 'orch') return;
    try {
      const dir = path.join(this.workspace, '.cluster');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'ledger.md'), this.ledgerText());
    } catch {}
    this.save();
  }

  orchPrimer() {
    return `[ORCHESTRATOR BRIEFING: you are starting with a fresh memory. This is everything kept so far.]
${this.ledgerText()}
## Cluster right now
${this.orchStatusText()}
[END OF BRIEFING]`;
  }

  orchStatusText() {
    const lines = IDS.map(id => {
      const x = this.agents[id], j = this.assignments.get(id);
      return `${id}: ${x.status()}${j ? ` — on: ${j.task.split('\n')[0].slice(0, 100)}` : ''}`;
    });
    const tickets = [...this.tickets.values()].map(t => `#${t.id} ${t.kind} from ${t.from}: ${t.summary.slice(0, 160)}`);
    const own = {};
    for (const [k, v] of this.owners) (own[v] ||= []).push(k);
    return `Mode: orch
ORCH: ${this.agents[ORCH].status()}
${lines.join('\n')}

Ownership:
${Object.entries(own).map(([id, fs]) => `${id}: ${fs.join(', ')}`).join('\n') || '(none)'}

Open tickets:
${tickets.join('\n') || '(none)'}`;
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
    if (p.command) return this.guardShell(a, p.command, p.cwd);
    if (!p.file) return { allow: true };
    const k = this.norm(p.file, p.cwd);
    if (a.id === ORCH) return { allow: false, reason: 'The orchestrator does not edit files. Assign the change to a worker.' };
    // Orch mode: each file has one owning worker, set by the orchestrator. Unowned files go to whoever edits first.
    if (this.mode === 'orch') {
      const own = this.ownerOf(k);
      if (own && own !== a.id) {
        this.feed(a.id, 'err', `!! GUARD: ${path.basename(k)} is owned by ${own}`);
        return { allow: false, reason: `${p.file} is owned by ${own}. Don't change it another way (no shell writes). Ask ${own} to make the change with mcp__cluster__message_agent, or escalate (kind "files" or "change") so the orchestrator can decide.` };
      }
      if (!own) {
        this.owners.set(k, a.id);
        this.assignments.get(a.id)?.took.push(String(p.file));
        this.writeLedger();
      }
    }
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
  // another agent holds AND looks like it writes, moves or deletes something. A file name
  // counts only if it points at the claimed file's folder (a path written before it, else
  // the last cd, else the agent's own folder), so a same-named file elsewhere is fine.
  guardShell(a, cmd, cwd) {
    const WRITE_RE = /(^|[^-=<2&])>{1,2}(?!&)|\b(set-content|add-content|out-file|remove-item|move-item|copy-item|rename-item|new-item|tee|truncate|rm|mv|cp|del|erase|ren|rename)\b|\bsed\s+-i|\bgit\s+(checkout|restore|reset|stash|clean|rm|mv)\b/i;
    if (!WRITE_RE.test(cmd)) return { allow: true };
    const low = cmd.toLowerCase().replace(/\\/g, '/').replace(/(^|[\s"'=(])\/([a-z])\//g, '$1$2:/');
    // Orch mode also protects owned files (single files only; folders and globs are checked on edit).
    const held = [...this.claims];
    if (this.mode === 'orch') for (const [k, v] of this.owners) if (!k.includes('*') && path.extname(k)) held.push([k, v]);
    for (const [file, owner] of held) {
      if (owner === a.id || (a.current?.chain || []).includes(owner)) continue;
      const base = path.basename(file);
      if (!this.shellMentions(low, base, cwd).includes(file)) continue;
      this.feed(a.id, 'err', `!! GUARD: shell write touching ${base} (claimed by ${owner})`);
      return { allow: false, reason: `This command looks like it changes ${base}, which ${owner} has claimed. Don't change that file. Ask ${owner} with mcp__cluster__ask_agent, wait, or do other work. (If this is a different file with the same name, use the Edit/Write tools instead.)` };
    }
    return { allow: true };
  }

  // Full paths of every place `base` appears in a (lowercased, forward-slash) command.
  shellMentions(low, base, cwd) {
    const cds = [];
    const CD_RE = /(?:^|[;&|(\n])\s*(?:cd|pushd|set-location)\s+(?:\/d\s+)?(?:"([^"]*)"|'([^']*)'|([^\s;&|)]+))/g;
    let m, dir = cwd || this.workspace;
    while ((m = CD_RE.exec(low))) { dir = path.resolve(dir, m[1] ?? m[2] ?? m[3]); cds.push([m.index, dir]); }
    const out = [];
    for (let i = low.indexOf(base); i !== -1; i = low.indexOf(base, i + 1)) {
      if (/[a-z0-9_.-]/.test(low[i + base.length] || '') || /[a-z0-9_-]/.test(low[i - 1] || '')) continue;
      let start = i;
      if (low[i - 1] === '/') {
        // A drive path or a quoted path may hold spaces ("c:/my folder/x.js"); otherwise the path ends at a space.
        const before = low.slice(Math.max(0, i - 260), i);
        let s = before.search(/[a-z]:\/(?:(?![a-z]:\/)[^"'`;&|<>\n])*$/);
        if (s === -1) s = before.search(/(?<=["'])[^\s"'`;&|<>()=,][^"'`;&|<>()=,\n]*$/);
        if (s === -1) s = before.search(/[^\s"'`;&|<>()=,]*$/);
        start = i - before.length + s;
      }
      let at = cwd || this.workspace;
      for (const [pos, d] of cds) if (pos < i) at = d;
      out.push(path.resolve(at, low.slice(start, i + base.length)).toLowerCase());
    }
    return out;
  }

  statusText() {
    if (this.mode === 'orch') return this.orchStatusText();
    const lines = IDS.map(id => this.agents[id]).map(x => {
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
    const env = { ...this.node.env, CT_AGENT: a.id, CT_MODE: this.mode, CT_PORT: String(this.port), CT_TOKEN: this.token };
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
    if (this.mode === 'orch') return a.id === ORCH ? this.orchSystemPrompt() : this.workerSystemPrompt(a);
    const others = IDS.filter(x => x !== a.id).join(', ');
    return `You are agent ${a.id} in CLUSTER TERMINAL, a team of six Claude Code agents (C1–C6) sharing one project folder: ${this.workspace}
The other agents are ${others}. INDIVIDUAL MODE: the operator gives you your own task. Work on it in your own lane.

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
5. When a message starts with "[REQUEST FROM Cx]", do exactly that and finish with a short report. Your final message is returned to that agent.
6. You run headless: nobody can answer questions mid-turn. If something is unclear, make a sensible choice and say so at the end.`;
  }

  orchSystemPrompt() {
    return `You are ORCH, the orchestrator of CLUSTER TERMINAL. Six Claude Code workers (C1–C6) share one project folder: ${this.workspace}
The operator talks only to you. You are the authority in the middle of a star: you plan the work, split it, assign it, decide who owns which files, referee disagreements, and keep the project's memory. You never write project code yourself: Edit and Write are disabled for you, and don't write files through the shell either. You may read files and run read-only commands, builds and tests to check work.

MEMORY. Workers start every assignment with a fresh memory, and your own memory is reset whenever it grows large. The LEDGER (mcp__cluster__ledger_write / ledger_read, saved as .cluster/ledger.md in the project) is what survives. Keep these sections current, short and factual (outcomes and pointers to files, never copies of code):
- Goal: what the operator asked for, in a few lines.
- Plan: the pieces, who has each, what depends on what, and status.
- Contracts: the exact interfaces where pieces meet (function signatures, data shapes, file formats, endpoints, events, shared names).
- Decisions: settled choices with a one-line reason (rulings are added automatically).
- Open questions.
Ownership, running assignments and open tickets are kept automatically.

PLANNING HEAVY, LINKED WORK.
1. Understand before splitting: read just enough of the project to map the pieces and how they connect (who calls whom, shared data, shared files).
2. Split along seams, not to keep everyone busy. Pieces that are tightly linked go to ONE worker. Use only as many workers as the work genuinely runs in parallel: often two or three, sometimes one.
3. Contracts first: where two pieces meet, write the contract into the ledger before assigning and quote it in both briefings. If nobody knows the contract yet, have one worker define it first, then fan out.
4. Order by dependency: assign what can start now; assign dependent pieces when their prerequisites report back.
5. Every file being changed has exactly one owner (the owns list of an assignment: files, folders or globs, relative to the project). Shared files (package.json, configs, shared types) get one owner; others go through that owner or a ticket.
6. Briefings are self-contained, because the worker remembers nothing: goal, files it owns, contracts it must meet, relevant decisions, its neighbours and what they own, how to verify. Use the context field for this.
7. When reports arrive: check contract impact, record outcomes in the ledger, assign fixes or the next wave, and verify the joined result (build, tests, a quick run) before you call it done.
8. Tickets: a worker is paused until you rule (mcp__cluster__rule). Rule quickly and decisively: pick what best fits the goal and the existing contracts, give the reason in one line, grant files if needed. Disagreements between workers are yours to settle. Only bring a choice to the operator if it changes what the operator asked for.
9. When everything is done and verified, give the operator a short summary: what was built, how it was checked, anything left open.

HOW YOU HEAR THINGS. Messages arrive as operator instructions, [REPORT FROM Cx], [TICKET #n ...] and [MESSAGE FROM Cx] (several may be bundled into one message). After assigning, end your turn; reports come to you as new messages. Never wait or poll. Your chat replies are shown to the operator, so keep them brief.

Tools: assign, rule, ledger_read, ledger_write, set_ownership, message_agent (tell a working worker something; it reads it between steps), comms_log (worker-to-worker traffic), cluster_status, set_tasks / update_task (your progress meter for the operator).
You run headless: nobody can answer questions mid-turn. If something is unclear, make a sensible choice and say so.`;
  }

  workerSystemPrompt(a) {
    return `You are worker ${a.id} in CLUSTER TERMINAL, ORCH MODE: six Claude Code workers (C1–C6) building linked pieces of one project in parallel, in the folder ${this.workspace}
ORCH, the orchestrator, assigns your work, owns the file map and settles disputes. Its word is final.

How to work:
1. Every assignment starts you with a fresh memory. The briefing holds everything you need; read the files it points to rather than guessing.
2. Edit only files you own (listed in the briefing). A file nobody owns becomes yours when you edit it; mention it in your report. Edits to files another worker owns are refused: ask that worker with mcp__cluster__message_agent to make the change, or escalate. Never get around it with shell writes.
3. Contracts and decisions in the briefing are binding. To change a contract, or when you and a neighbour disagree about something that touches both of you, call mcp__cluster__escalate (kind "change" or "dispute", naming the agents involved, with the options and your recommendation). It waits for ORCH's ruling. Don't change a shared interface on your own.
4. mcp__cluster__message_agent: quick questions and heads-ups to a neighbour (C1–C6) or to ORCH. Neighbours read messages between steps. When a tool result says you have unread messages, call mcp__cluster__read_messages; also call it before you finish. To wait for an answer you need, call read_messages with wait_seconds (up to 180).
5. mcp__cluster__set_tasks / update_task: your progress meter. Post a short list, then mark items in_progress and completed.
6. Stay inside your assignment. Don't reformat or "tidy" other files. Never run git commands that change others' work (reset, checkout of files, stash, clean, rebase, force push).
7. Check your piece works before you finish (run it, test it, or at least syntax-check it), then end with the REPORT block from the briefing. Your final message goes to ORCH.
You run headless: nobody can answer questions mid-turn. If something small is unclear, make a sensible choice and note it in the report.`;
  }
}

module.exports = { Cluster, IDS, ORCH, ALL };
