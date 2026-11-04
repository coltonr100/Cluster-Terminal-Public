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
const { Checks, isHeavy } = require('./checks');
// Queue item names that are only checking someone else's work (builders test and check their own piece).
const CHECK_JOB_RE = /(^|[-_\s])(tests?|testing|verify|verification|audit|qa|smoke|e2e)([-_\s]|$)/i;
// A shell command that writes a file's contents: a heredoc fed into a file, or PowerShell's file writers.
const SHELL_FILE_WRITE_RE = /<<-?\s*['"]?\w+['"]?[^\n]*(>|\btee\b)|(>|\btee\b)[^\n]*<<-?\s*['"]?\w+|\b(set-content|add-content|out-file)\b|\[(system\.)?io\.file\]::write/i;

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
  orchResetAtTokens: 150000,
  handoffTimeoutMinutes: 10,
  autoDisputeMessages: 8,
  workerPortBase: 4100,
  maxWaitSeconds: 20,
  checkSlots: 2,
  checkTimeoutMinutes: 10,
  routeChecks: true,
  guardHook: 'http',
  workerPermissionMode: '',
  continueBelowTokens: 100000,
  integrateEveryMinutes: 10,
  leanAgents: true,
  orchTools: '',
  workerTools: '',
  workerModel: 'sonnet',
  criticalModel: '',
  orchBatchSeconds: 8,
  shellTimeoutSeconds: 45,
  reviewMinutes: 4,
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
    this.area = new Set();                    // orch mode: files this session has worked on (memory is kept for work there)
    this.toolCmds = new Map();                // tool_use id -> shell command, to spot one failing over and over
    this.fails = new Map();                   // shell command -> failures in a row
  }

  // New Claude Code session (orch mode: unrelated work, or a memory past continueBelowTokens, starts clean).
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
    this.turnT = Date.now();
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
    // Lean start (orch mode, leanAgents): only the cluster's MCP server, no skills list, no CLAUDE.md files
    // from the operator's folders, and a short built-in tool list. Cuts each agent's starting context ~4x,
    // and every step re-sends that context. The project's own CLAUDE.md is added to the prompt instead.
    const lean = c.mode === 'orch' && cfg.leanAgents !== false;
    const tools = this.id === ORCH ? (cfg.orchTools || 'Bash,PowerShell,Read,Write,Glob,Grep') : (cfg.workerTools || 'Bash,PowerShell,Read,Edit,Write,Glob,Grep');
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      // Orch-mode workers can run in their own permission mode (workerPermissionMode in config.json).
      '--permission-mode', (c.mode === 'orch' && this.id !== ORCH && cfg.workerPermissionMode) || cfg.permissionMode,
      '--mcp-config', files.mcp,
      '--settings', files.settings,
      '--append-system-prompt', c.systemPrompt(this) + (lean ? c.projectRules() : ''),
      '--allowedTools', 'mcp__cluster__*',
      ...(lean ? ['--strict-mcp-config', '--disable-slash-commands', '--tools', tools] : []),
      ...(this.resumable ? ['--resume', this.sessionId] : ['--session-id', this.sessionId]),
    ];
    // The orchestrator plans and judges; it can read and run checks but not edit files.
    // Write stays on only so it can save the spec sections; the guard refuses anything outside .cluster/spec/.
    if (this.id === ORCH) args.push('--disallowedTools', 'Edit', 'MultiEdit', 'NotebookEdit');
    const model = this.id === ORCH ? (cfg.orchModel || cfg.model) : (this.jobModel || cfg.model);
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
    // A stuck shell command (one waiting for typed input, a server left in front) ends after shellTimeoutSeconds
    // instead of Claude Code's 2 minutes. Builds and tests go through check, which has its own limit.
    if (c.mode === 'orch' && cfg.shellTimeoutSeconds) env.BASH_DEFAULT_TIMEOUT_MS = String(cfg.shellTimeoutSeconds * 1000);
    if (lean) env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
    // Each worker gets its own block of ports, so test servers started by different agents never collide.
    const ports = c.portRange(this.id);
    if (ports) { env.PORT = String(ports[0]); env.CT_PORTS = `${ports[0]}-${ports[1]}`; }
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

  // ORCH's stop tool: kill the process tree now, drop the turn and anything queued, start the next work fresh.
  halt(reason) {
    const p = this.proc;
    this.proc = null;
    this.stopping = true;
    killTree(p);
    const items = [...this.queue, ...(this.current ? [this.current] : [])];
    this.queue = [];
    this.current = null;
    this.busy = false;
    clearTimeout(this.interruptTimer);
    this.interrupting = false;
    this.compacting = false;
    this.compactQueued = false;
    this.waitingOn.clear();
    this.tasks = [];
    this.freshSession();
    this.area = new Set();
    for (const item of items) item.onDone(reason);
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
    this.c.statOf(this.id).out += cur.o - prev.o;
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
          c.statTool(this, b);
          if (b.input?.command && /^(Bash|PowerShell)$/.test(b.name)) this.toolCmds.set(b.id, String(b.input.command).trim());
        }
      }
      c.emitAgent(this);
    } else if (ev.type === 'user') {
      const content = ev.message?.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type !== 'tool_result') continue;
        c.statToolDone(this, b.tool_use_id);
        this.noteFailure(b);
        const raw = typeof b.content === 'string' ? b.content
          : (b.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
        const lines = raw.trim().split(/\r?\n/).slice(0, 4).join('\n');
        if (lines) c.feed(this.id, b.is_error ? 'err' : 'out', clip(lines, 300));
      }
    } else if (ev.type === 'result') {
      this.finishTurn(typeof ev.result === 'string' && ev.result ? ev.result : this.lastText);
    }
  }

  // The same shell command failing three times in a row is an agent going in circles: tell it once.
  noteFailure(b) {
    const cmd = this.toolCmds.get(b.tool_use_id);
    if (!cmd) return;
    this.toolCmds.delete(b.tool_use_id);
    if (!b.is_error) { this.fails.delete(cmd); return; }
    const n = (this.fails.get(cmd) || 0) + 1;
    this.fails.set(cmd, n);
    if (n !== 3 || this.c.mode !== 'orch' || this.id === ORCH) return;
    this.c.feed(this.id, 'err', '!! same command failed 3 times');
    this.c.deliver(ORCH, this.id, `[HUB] You have run the same command three times and it failed each time: ${cmd.slice(0, 160)}. Stop repeating it. Change the approach, or if the cause is in another worker's files, message that owner with the output and carry on with your own work.`, 'message');
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
    if (item && !item.internal) this.c.statTurn(this);
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
    this.checks = new Checks({ node: this.node, gitBash: this.gitBash, slots: this.cfg.checkSlots || 2, timeoutMs: (this.cfg.checkTimeoutMinutes || 10) * 60000, killTree });
    this.agents = Object.fromEntries(ALL.map(id => [id, new Agent(id, this)]));
    this.resetStats();
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
    // Turns spec PDFs into text before ORCH reads them (comes with Git for Windows; poppler on Mac/Linux).
    this.pdftotext = findExe(WIN
      ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'mingw64', 'bin', 'pdftotext.exe'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'mingw64', 'bin', 'pdftotext.exe')]
      : ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext', '/usr/bin/pdftotext'], 'pdftotext');
    if (this.checks) Object.assign(this.checks, { node: this.node, gitBash: this.gitBash });
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
    for (const h of this.handoffs?.values() || []) clearTimeout(h.timer);
    if (this.orchHold) clearTimeout(this.orchHold.timer);
    this.orchHold = null;          // hub notices held briefly so ORCH wakes once for several (notifyOrch)
    this.owners = new Map();      // normalised path (file, folder or glob) -> owning worker; lasts across turns
    this.assignments = new Map();  // worker -> { task, owns, t, took }
    this.tickets = new Map();      // ticket number -> { id, from, kind, summary, agents, resolve, t }
    this.ticketSeq = 0;
    this.handoffs = new Map();     // handoff number -> { id, from, to, files, task, context, t, notified, timer }
    this.handoffSeq = 0;
    this.freeSince = {};           // worker -> when its last assignment ended (for the load board)
    this.chatter = new Map();      // "Cx-Cy" -> recent messages between two workers (back-and-forth detection)
    this.mail = Object.fromEntries(ALL.map(id => [id, []]));
    this.mailWaiters = new Map();
    this.comms = [];               // agent-to-agent traffic the orchestrator can look through
    this.backlog = [];             // queued work: { name, task, owns, context, after, model, state, agent }; free workers pull it
    this.teamSize = IDS.length;    // how many workers the queue may keep busy at once (ORCH sets it)
    this.autoStarted = [];         // queue items started since ORCH last saw the load board
    this.ledger = {};              // section -> text; written to <project>/.cluster/ledger.md
    this.integration = null;       // { command, last, failing, running }: ORCH's integration check, run by the hub
    this.queueHeld = false;        // set when ORCH stops every worker but keeps the queue; new queue_work items lift it
    if (this.splitAsk) clearTimeout(this.splitAsk.timer);
    this.splitAsk = null;          // { from, t, notified, timer }: the busy worker the hub asked to split off work for a free one
    this.splitDeclined = {};       // worker -> when it last answered "nothing separable" (or didn't answer)
    this.splitSeq = 0;
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
      // Workers don't survive a restart, so queue items that were running wait to be picked up again.
      this.backlog = (st.orch.backlog || []).map(b => (b.state === 'running' ? { ...b, state: 'queued', agent: null } : b));
      this.teamSize = st.orch.teamSize || IDS.length;
      if (st.orch.integration) this.integration = { command: st.orch.integration, last: 0, failing: false, running: false };
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
    if (st.stats?.agents) this.stats = { ...this.stats, ...st.stats };
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
      const orch = { owners: [...this.owners], ledger: this.ledger, backlog: this.backlog, teamSize: this.teamSize, integration: this.integration?.command || null };
      fs.writeFileSync(this.statePath, JSON.stringify({ workspace: this.workspace, mode: this.mode, agents, chats: this.log, feeds: this.feedLog, orch, stats: this.stats }));
    } catch {}
  }

  async start() {
    await new Promise(res => {
      this.server = http.createServer((req, rsp) => {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', async () => {
          // The agents' file guard, as an HTTP hook: Claude Code posts the PreToolUse event here,
          // which saves starting a Node process for every edit and command.
          if (req.url === '/hook') {
            rsp.writeHead(200, { 'Content-Type': 'application/json' });
            return rsp.end(this.hookReply(req.headers, body));
          }
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
    this.checks.stopAll();
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
    const cmd = text.trim().toLowerCase();
    if (cmd === '/stats' || cmd === '/stats reset') {
      if (cmd === '/stats reset') { this.resetStats(); this.sys(id, 'Run stats reset. The clock starts at the next instruction.'); return; }
      this.sys(id, this.statsText());
      this.writeStatsFile();
      return;
    }
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
    this.stats.t0 ||= Date.now();
    // Orch mode: a PDF named in the instruction is turned into text before ORCH starts, so nobody reads the PDF itself.
    if (this.mode === 'orch') text += this.prepSpec(text);
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
      if (this.orchHold) { clearTimeout(this.orchHold.timer); this.orchHold = null; }
      for (const t of this.tickets.values()) t.resolve({ text: '[halted by operator]' });
      this.tickets.clear();
      for (const h of [...this.handoffs.values()]) this.endHandoff(h);
      for (const w of this.assignments.keys()) this.setLink(ORCH, w, false);
      this.assignments.clear();
    }
  }

  clearAll() {
    for (const a of Object.values(this.agents)) a.clear();
    this.checks.stopAll();
    this.resetStats();
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
    // Early splits come due with time (a long critical item ~1 min in), not only on events.
    if (this.mode === 'orch') this.maybeAskSplit();
    for (const a of Object.values(this.agents)) {
      if (a.id === ORCH) {
        // The orchestrator isn't compacted: between turns it gets a fresh memory and reloads from the ledger.
        if (this.mode !== 'orch' || !a.proc || a.busy || a.queue.length || a.ctx < (this.cfg.orchResetAtTokens || 150000)) continue;
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
      case 'handoff': orchOnly(); return this.handoff(p);
      case 'queue_work': orchOnly(); return this.queueWork(p);
      case 'stop': orchOnly(); return this.stopWorkers(p);
      case 'hand_over': workerOnly(); return this.handOver(a, p);
      case 'propose_work': workerOnly(); return this.proposeWork(a, p);
      case 'offer_split': workerOnly(); return this.offerSplit(a, p);
      case 'mark_ready': workerOnly(); return this.markReady(a, p);
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
        if (orch && t.status === 'completed') this.nearlyDone(a);
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
      case 'check': return this.check(a, p);
      case 'guard': return this.guard(a, p);
      default: throw new Error('unknown method ' + method);
    }
  }

  norm(f, cwd) {
    const k = path.resolve(cwd || this.workspace, String(f));
    return WIN || process.platform === 'darwin' ? k.toLowerCase() : k;
  }

  // C1 gets 4100–4199, C2 4200–4299, ... (workerPortBase in config.json moves the whole block).
  portRange(id) {
    const i = IDS.indexOf(id);
    if (i < 0) return null;
    const base = (this.cfg.workerPortBase || 4100) + i * 100;
    return [base, base + 99];
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
      if (!this.isFree(id)) { refused.push(`${id}: busy with "${this.assignments.get(id)?.task.slice(0, 60) || (this.reservedBy(id) ? `handoff #${this.reservedBy(id).id}` : 'other work')}"`); continue; }
      const owns = (t.owns || []).map(String);
      const clash = this.ownershipClash(id, owns);
      if (clash) { refused.push(`${id}: ${clash.text}${this.assignments.has(clash.owner) ? ` (to move part of ${clash.owner}'s work to ${id}, use handoff)` : ''}`); continue; }
      const name = String(t.name || '').trim();
      if (name && this.backlog.some(b => b.name === name && b.state === 'running')) { refused.push(`${id}: "${name}" is already running`); continue; }
      const card = this.card(t);
      // Memory: fresh=true wipes, fresh=false keeps; by default the worker keeps it for work in its own area.
      const keep = t.fresh === true ? false : t.fresh === false ? w.resumable : this.canKeep(w, { owns, after: [] }) && (!t.model || String(t.model) === (w.jobModel || ''));
      const model = t.model ? String(t.model) : keep ? (w.jobModel || null) : this.tierModel(t);
      const job = this.recordJob(w, String(t.task || ''), owns, { model, item: name || null, continued: keep, ...card });
      // A named assignment joins the queue as running, so queued items can wait for it (after).
      if (name) {
        this.backlog = this.backlog.filter(b => b.name !== name);
        this.backlog.push({ name, task: job.task, owns, context: String(t.context || ''), after: [], model, state: 'running', agent: id, ...card });
      }
      done.push({ w, job, t });
    }
    // Brief after recording every assignment, so each briefing lists all of its neighbours.
    for (const { w, job, t } of done) this.startJob(w, job, t.context, !job.continued);
    this.dispatch();
    this.writeLedger();
    this.emitAgent(o);
    let text = done.length ? `Assigned: ${done.map(d => d.w.id).join(', ')}. Their reports come to you as new messages ([REPORT FROM Cx]). Don't wait or poll; end your turn unless you have more to assign.` : 'Nothing assigned.';
    if (refused.length) text += `\nRefused:\n- ${refused.join('\n- ')}`;
    return { text };
  }

  // Predictive scheduling: a worker ~80% through its task list with nothing queued to follow is about to sit idle.
  // ORCH hears once per assignment, so it can line up the next work before the report lands.
  nearlyDone(w) {
    const job = this.assignments.get(w.id);
    if (!job || job.nudged || w.tasks.length < 3) return;
    const done = w.tasks.filter(t => t.status === 'completed').length;
    if (done / w.tasks.length < 0.8 || this.backlog.some(b => b.state === 'queued')) return;
    job.nudged = true;
    const others = [...this.assignments.keys()].filter(id => id !== w.id);
    this.notifyOrch(`[HEADS-UP] ${w.id} is nearly done (${done}/${w.tasks.length} tasks) with "${job.task.split('\n')[0].slice(0, 80)}" and the queue is empty, so it will be idle soon.${others.length ? ` Still working: ${others.join(', ')}.` : ''} If work remains, queue it now (queue_work) so ${w.id} starts the moment it reports. If nothing is left, just end your turn.`);
  }

  // A worker can take new work: not running, nothing queued, no assignment, not promised to a pending handoff.
  isFree(id) {
    const w = this.agents[id];
    return !w.busy && !w.queue.length && !this.assignments.has(id) && !this.reservedBy(id);
  }

  reservedBy(id) { return [...this.handoffs.values()].find(h => h.to === id) || null; }

  // Record an assignment: the worker's ownership becomes exactly `owns` (an idle worker's old files are released).
  recordJob(w, task, owns, extra = {}) {
    for (const [k, v] of this.owners) if (v === w.id) this.owners.delete(k);
    for (const f of owns) this.owners.set(this.norm(f), w.id);
    const job = { task, owns, t: Date.now(), took: [], ...extra };
    this.assignments.set(w.id, job);
    this.stats.jobs.push({ agent: w.id, task: task.split('\n')[0].slice(0, 80), item: job.item || null, t: job.t, end: null, model: job.model || null, est: job.estMinutes ?? null, critical: job.priority === 'critical' });
    this.chat(w.id, 'peer', task, ORCH, 'assign');
    this.logComms(ORCH, w.id, 'assign', task);
    w.connected.add(ORCH); this.agents[ORCH].connected.add(w.id);
    this.setLink(ORCH, w.id, true);
    return job;
  }

  startJob(w, job, context, fresh = true) {
    w.jobModel = job.model || null;
    if (fresh) w.area = new Set();
    for (const f of job.owns) w.area.add(this.norm(f));
    // A review is a short spot check: when its time is up the hub tells it to report, and refuses further commands.
    if (job.review) {
      const mins = this.cfg.reviewMinutes ?? 4;
      job.reviewTimer = setTimeout(() => {
        if (this.assignments.get(w.id) !== job) return;
        job.timeUp = true;
        this.deliver(ORCH, w.id, `[HUB] Your ${mins} minutes for this review are up. Stop checking and send your REPORT now with what you found.`, 'message');
      }, mins * 60000);
    }
    w.send(this.briefing(w, job, context), { chain: [ORCH], origin: ORCH, fresh })
      .then(reply => this.onReport(w, job, reply));
  }

  // Does this work sit in the worker's own area? 2: it built what the item builds on; 1: the item touches
  // files it worked on this session; 0: unrelated.
  related(w, item) {
    if ((item.after || []).some(n => this.backlog.find(b => b.name === n)?.by === w.id)) return 2;
    const area = [...(w.area || [])];
    const near = (x, k) => x === k || this.ownerMatch(x, k) || this.ownerMatch(k, x);
    return (item.owns || []).some(f => { const k = this.norm(f); return area.some(x => near(x, k)); }) ? 1 : 0;
  }

  // A worker keeps its memory for related work until it passes continueBelowTokens (then it starts fresh,
  // with its earlier reports in the briefing). Unrelated work always starts fresh.
  canKeep(w, item) {
    return w.resumable && w.ctx < (this.cfg.continueBelowTokens ?? 100000) && this.related(w, item) > 0;
  }

  briefing(w, job, context) {
    const others = [...this.assignments].filter(([id]) => id !== w.id)
      .map(([id, j]) => `- ${id}: ${j.task.split('\n')[0].slice(0, 120)} (owns: ${j.owns.join(', ') || 'nothing yet'})`);
    const keep = ['Goal', 'Contracts', 'Decisions'].filter(s => this.ledger[s]).map(s => `## ${s}\n${this.ledger[s]}`).join('\n\n');
    const ports = this.portRange(w.id);
    const spec = this.specFiles(), source = this.specFiles(true);
    // Handoff summaries for free: the reports of the items this one builds on, so nobody re-explores that code.
    const item = job.item && this.backlog.find(b => b.name === job.item);
    // Critical items still running elsewhere (usually setup): this worker codes on instead of waiting.
    const setup = this.backlog.filter(b => b.state === 'running' && b.priority === 'critical' && b.agent !== w.id && b.name !== job.item)
      .map(b => `"${b.name}" (${b.agent}${b.provides?.length ? `, provides ${b.provides.join(', ')}` : ''})`);
    let budget = 5000;
    const prior = (item?.after || []).map(n => this.backlog.find(b => b.name === n)).filter(b => b?.report || b?.interfaceReady).map(b => {
      if (!b.report) return `### ${b.name} (interface ready; ${b.agent} is still finishing the rest, so code against this and message ${b.agent} if it doesn't match)\n${clip(b.interfaceReady, 1200)}`;
      const r = clip(b.report, Math.max(300, Math.min(1500, budget)));
      budget -= r.length;
      return `### ${b.name} (built by ${b.by})\n${r}`;
    });
    // Starting fresh on files that earlier items built: their reports stand in for the memory that was cleared.
    if (!job.continued && job.owns.length) {
      const mine = job.owns.map(f => this.norm(f));
      const near = (x, k) => x === k || this.ownerMatch(x, k) || this.ownerMatch(k, x);
      for (const b of this.backlog) {
        if (b.state !== 'done' || !b.report || b.name === job.item || (item?.after || []).includes(b.name)) continue;
        if (!(b.owns || []).some(f => mine.some(x => near(x, this.norm(f))))) continue;
        if (budget < 300) break;
        const r = clip(b.report, Math.min(1200, budget));
        budget -= r.length;
        prior.push(`### ${b.name} (earlier work on these files, by ${b.by})\n${r}`);
      }
    }
    const review = job.review ? `\nThis is a REVIEW: a short, report-only spot check, ${this.cfg.reviewMinutes ?? 4} minutes at most. Edit nothing (edits are refused). Read just the spec sections named above, run a handful of the spec's own examples through mcp__cluster__check, and compare. Send each real gap straight to the owner of those files with mcp__cluster__message_agent (the input, expected and actual output), then list them in your report. Skip style, naming and anything the spec doesn't require. Don't write test files.\n` : '';
    return `[ASSIGNMENT FROM ORCH]${job.item ? ` "${job.item}"` : ''}
${job.task}
${review}${job.doneWhen ? `\nDone when (check each before you report): ${job.doneWhen}\n` : ''}${job.provides?.length ? `\nYou provide: ${job.provides.join('; ')}. Others build on it: the moment that interface is final (exports compile, endpoint answers), call mark_ready with a short summary and one example call with its result, so the work waiting on it starts at once and nobody guesses how it behaves, then carry on.\n` : ''}${job.priority === 'critical' ? '\nThis is on the critical path: other work is waiting for it. Keep it lean and finish it first.\n' : ''}
Files you own (only you may edit them): ${job.owns.join(', ') || '(none listed; unowned files you edit become yours)'}
${prior.length ? `\nWhat the work you build on reported (read this instead of re-exploring that code):\n${prior.join('\n\n')}\n` : ''}${job.handoff ? `\nThis work was handed to you by ${job.handoff.from} (handoff #${job.handoff.id}), which is still working on the rest of its piece. Its notes:\n${job.handoff.notes || '(none)'}\n` : ''}${context ? `\nContext from the orchestrator:\n${context}\n` : ''}${spec.length ? `\nSpec guide: ${spec.map(f => path.join(this.workspace, '.cluster', 'spec', f)).join(', ')}. index.md (if there) maps each section to line ranges of the source text: Read just those lines (offset/limit) for the sections your work needs; don't read the whole document.\n` : ''}${source.length ? `${spec.length ? 'Only if a section leaves something out, search' : 'The spec as plain text (search it for what your piece needs rather than reading it all)'}: ${source.map(f => path.join(this.workspace, '.cluster', 'spec', f)).join(', ')}. Never open the original PDF.\n` : ''}
Your ports for any server you start, including test servers: ${ports[0]}–${ports[1]} (PORT is set to ${ports[0]}). Never use another port.
The cluster's notes (spec, ledger, handoffs, contracts) are in ${path.join(this.workspace, '.cluster')}. Use that full path even if the code you build lives in another folder.
${setup.length ? `Still being set up: ${setup.join('; ')}. Don't wait for it: write your code now against the contracts, and run checks once it announces it is ready.\n` : ''}Other workers right now:
${others.join('\n') || '(none)'}
${keep ? `\nFrom the project ledger (binding):\n${keep}\n` : ''}
${job.continued ? 'This continues your previous session: you already know the code you built. Read only what is new.' : 'You start with a fresh memory; everything you need is above or in the files.'}${job.review ? '' : ' Build it, write and run the tests for it yourself, then check it against its spec sections and done-when list before you report (a quick pass over the rules and examples, not a re-read).'} You own this task: plan its details yourself (your task list) and decide how it is built. When you finish, end with this report. It is handed to whoever builds on your work, so keep it under ~150 words:
REPORT
Done: <one or two lines>
Changed files: <list, with the main exports/endpoints others use>
Decisions I made: <short list, or none>
Contract impact: <none, or what changed and who is affected>
Left / gotchas: <what's not done, traps for whoever builds on this, or none>`;
  }

  onReport(w, job, reply) {
    clearTimeout(job.reviewTimer);
    if (this.assignments.get(w.id) !== job) return;   // halted or reset meanwhile
    this.assignments.delete(w.id);
    for (const f of job.took) w.area.add(this.norm(f));
    if (this.splitAsk?.from === w.id) { clearTimeout(this.splitAsk.timer); this.splitAsk = null; }
    w.connected.delete(ORCH); this.agents[ORCH].connected.delete(w.id);
    this.setLink(ORCH, w.id, false);
    this.logComms(w.id, ORCH, 'report', reply);
    this.freeSince[w.id] = Date.now();
    const rec = this.stats.jobs.findLast(j => j.agent === w.id && j.t === job.t);
    if (rec) rec.end = Date.now();
    // A finished queue item may unblock others; free workers pick them up before ORCH even reads this.
    const item = job.item && this.backlog.find(b => b.name === job.item && b.agent === w.id);
    if (item) {
      item.state = 'done'; item.agent = null; item.by = w.id;
      this.markCritical();
      // The report doubles as the handoff summary for items that build on this one.
      item.report = clip(String(reply).slice(Math.max(0, String(reply).lastIndexOf('REPORT'))), 2000);
      try {
        const dir = path.join(this.workspace, '.cluster', 'handoffs');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, item.name.replace(/[^a-z0-9._-]+/gi, '-') + '.md'), `# ${item.name} (built by ${w.id})\n\n${item.report}\n`);
      } catch {}
    }
    // A handoff this worker never confirmed is void: it finished first, so the work may already be done.
    const dropped = [];
    for (const h of [...this.handoffs.values()]) {
      if (h.from !== w.id) continue;
      this.endHandoff(h);
      dropped.push(`#${h.id} (${h.files.join(', ')} → ${h.to})`);
    }
    const took = job.took.length ? `\n(${w.id} also took ownership of: ${job.took.join(', ')})` : '';
    const handed = job.handedOff?.length ? `\n(${w.id} handed off: ${job.handedOff.join('; ')})` : '';
    const void_ = dropped.length ? `\n(Handoff ${dropped.join(', ')} was cancelled: ${w.id} finished before handing over. Check its report for whether that work is done; ${dropped.length > 1 ? 'those workers are' : 'that worker is'} free again.)` : '';
    this.dispatch();
    this.maybeIntegrate();
    // The run is over when nothing is running or queued: save the metrics for comparing runs.
    if (!this.assignments.size && !this.backlog.some(b => b.state !== 'done')) this.writeStatsFile();
    const text = `[REPORT FROM ${w.id}] task: ${job.task.split('\n')[0].slice(0, 120)}${job.item ? ` (queue item "${job.item}", now marked done; re-queue it with queue_work if it isn't)` : ''}\n${reply}${took}${handed}${void_}\n\n${this.loadBoard()}`;
    this.notifyOrch(text);
    this.writeLedger();
    this.emitAgent(w);
  }

  // What ORCH sees with every report: who's still working, for how long, what's left on their task
  // lists, and who is free. When work is running and someone is free, it's asked to rebalance.
  loadBoard() {
    const now = Date.now(), min = t => Math.max(0, Math.round((now - t) / 60000));
    const running = [], free = [];
    for (const id of IDS) {
      const j = this.assignments.get(id), x = this.agents[id];
      if (j) {
        running.push(`- ${id}: ${min(j.t)} min on "${j.task.split('\n')[0].slice(0, 80)}"${this.taskProgress(id)} · owns: ${j.owns.join(', ') || 'nothing'}`);
      } else if (this.reservedBy(id)) {
        running.push(`- ${id}: waiting to take handoff #${this.reservedBy(id).id}`);
      } else if (this.isFree(id)) {
        free.push(`${id}${this.freeSince[id] ? ` (free ${min(this.freeSince[id])} min)` : ''}`);
      }
    }
    const queue = this.queueSummary();
    const started = this.autoStarted.splice(0);
    const extra = `${started.length ? `\nAuto-started from the queue: ${started.join(', ')}` : ''}${queue ? `\n${queue}` : ''}`;
    if (!running.length) return `LOAD BOARD: no assignments are running. Free: ${free.join(', ') || 'none'}.${extra}`;
    let s = `LOAD BOARD\nStill working:\n${running.join('\n')}\nFree: ${free.join(', ') || 'none'}${extra}`;
    // dispatch() has already run, so a free worker inside the team size means the queue had nothing it could start.
    if (free.length && this.splitAsk) s += `\nSPLIT: the hub has asked ${this.splitAsk.from} (the piece most others wait on) whether part of its work can go to a free worker; you'll see [SPLIT] if it does. Don't also hand off from ${this.splitAsk.from}.`;
    else if (free.length && this.assignments.size < this.teamSize) s += `\nREBALANCE: the queue has nothing a free worker can start. If real remaining work can run in parallel, add it with queue_work (new work in files nobody owns) or handoff (unstarted parts inside a busy worker's files; they move once it reaches a safe point). Only move pieces that are separable and worth at least ~5 minutes of work, since a fresh worker spends ~2–3 minutes getting oriented. Idle workers cost nothing: never create test, verify, audit or review-the-others work just to keep them busy. If nothing qualifies, end your turn with "ok".`;
    return s;
  }

  // ---- handoff: move part of a busy worker's piece to a free worker without anyone editing a file twice ----
  // 1. ORCH proposes it. The receiver is reserved (nothing else can be assigned to it) and the giver is told.
  // 2. The giver brings those files to a working state, stops touching them and calls hand_over (or refuses).
  // 3. Only then do ownership and the giver's edit claims move, and the receiver starts with the giver's notes.
  handoff(p) {
    const from = String(p.from || '').toUpperCase(), to = String(p.to || '').toUpperCase();
    if (!IDS.includes(from) || !IDS.includes(to)) throw new Error('from and to must be workers (C1–C6).');
    if (from === to) throw new Error('from and to must be different workers.');
    if (!this.assignments.has(from)) throw new Error(`${from} has no running assignment. Its files are free to move: use assign.`);
    if (!this.isFree(to)) throw new Error(`${to} is not free${this.reservedBy(to) ? ` (promised to handoff #${this.reservedBy(to).id})` : ''}. Pick a free worker from the load board.`);
    const open = [...this.handoffs.values()].find(h => h.from === from);
    if (open) throw new Error(`${from} already has handoff #${open.id} waiting. Wait for it to finish.`);
    const files = (p.files || []).map(String).filter(Boolean);
    if (!files.length) throw new Error('files is required: the files, folders or globs (all owned by the giver) that move to the receiver.');
    for (const f of files) {
      const k = this.norm(f);
      if (this.owners.get(k) !== from && this.ownerOf(k) !== from) throw new Error(`${f} is not owned by ${from} (owner: ${this.ownerOf(k) || 'nobody'}). Handoffs only move the giver's own files.`);
    }
    const task = String(p.task || '').trim();
    if (!task) throw new Error('task is required: what the receiver does, and how to verify it.');
    const h = { id: ++this.handoffSeq, from, to, files, task, context: String(p.context || ''), t: Date.now(), notified: false };
    h.timer = setTimeout(() => {
      if (this.handoffs.get(h.id) !== h) return;
      this.endHandoff(h);
      this.notifyOrch(`[HANDOFF #${h.id} TIMED OUT] ${from} didn't hand over ${files.join(', ')} within ${this.cfg.handoffTimeoutMinutes || 10} min. Nothing moved; ${to} is free again.`);
    }, (this.cfg.handoffTimeoutMinutes || 10) * 60000);
    this.handoffs.set(h.id, h);
    this.deliver(ORCH, from, this.handoffNotice(h), 'handoff');
    this.logComms(ORCH, from, 'handoff', `#${h.id}: ${files.join(', ')} → ${to}: ${task}`);
    this.setLink(ORCH, to, true);
    this.emitAgent(this.agents[to]);
    this.writeLedger();
    return { text: `Handoff #${h.id} proposed: ${files.join(', ')} from ${from} to ${to}. ${to} is reserved. ${from} hands over at its next safe point; you'll get [HANDOFF #${h.id} DONE] (or REFUSED / TIMED OUT) as a new message. Don't wait; end your turn unless you have more to do.` };
  }

  handoffNotice(h) {
    return `[HANDOFF #${h.id} FROM ORCH] To finish sooner, part of your piece moves to ${h.to}, which is free.
Moving to ${h.to}: ${h.files.join(', ')}
${h.to}'s task: ${h.task}
Do this now, before anything else: finish or undo the edit you are in the middle of on those files so they are in a working state, stop touching them, then call mcp__cluster__hand_over with handoff ${h.id} and notes for ${h.to} (what's done, what's half-done, anything it must know). After that those files are ${h.to}'s: don't edit them, and drop them from your task list. If handing over would break something you can't leave (say why), call hand_over with refuse=true and a reason.`;
  }

  // Release a handoff's reservation (done, refused, timed out, or void).
  endHandoff(h) {
    clearTimeout(h.timer);
    this.handoffs.delete(h.id);
    if (!this.assignments.has(h.to)) this.setLink(ORCH, h.to, false);
    this.emitAgent(this.agents[h.to]);
    setImmediate(() => this.dispatch());
  }

  // The giver confirms (or refuses) a handoff.
  handOver(a, p) {
    const h = this.handoffs.get(p.handoff | 0);
    if (!h || h.from !== a.id) throw new Error(`No handoff #${p.handoff} waiting on you. Waiting: ${[...this.handoffs.values()].filter(x => x.from === a.id).map(x => '#' + x.id).join(', ') || 'none'}`);
    const notes = String(p.notes || p.reason || '').trim();
    this.endHandoff(h);
    if (p.refuse) {
      this.logComms(a.id, ORCH, 'handoff', `#${h.id} refused: ${notes}`);
      this.notifyOrch(`[HANDOFF #${h.id} REFUSED BY ${a.id}] ${notes || '(no reason given)'}\nNothing moved; ${h.to} is free again.`);
      this.writeLedger();
      return { text: `Refused. You keep ${h.files.join(', ')}. Carry on.` };
    }
    // Move ownership: the named entries, plus any of the giver's narrower entries inside them.
    const keys = h.files.map(f => this.norm(f));
    for (const [k, v] of [...this.owners]) if (v === a.id && keys.some(x => x === k || this.ownerMatch(x, k))) this.owners.delete(k);
    // Move the giver's edit claims on those files too, or the receiver would be refused until the giver's turn ends.
    for (const [k, v] of [...this.claims]) if (v === a.id && keys.some(x => x === k || this.ownerMatch(x, k))) this.claims.delete(k);
    const job = this.assignments.get(a.id);
    if (job) {
      job.owns = job.owns.filter(o => !keys.some(x => x === this.norm(o) || this.ownerMatch(x, this.norm(o))));
      (job.handedOff ||= []).push(`${h.files.join(', ')} → ${h.to}`);
    }
    const w = this.agents[h.to];
    this.stats.handoffs = (this.stats.handoffs || 0) + 1;
    const newJob = this.recordJob(w, h.task, h.files, { handoff: { id: h.id, from: a.id, notes }, model: this.tierModel({ priority: job?.priority }) });
    this.startJob(w, newJob, h.context, true);
    this.logComms(a.id, ORCH, 'handoff', `#${h.id} handed over to ${h.to}: ${notes}`);
    this.notifyOrch(`[HANDOFF #${h.id} DONE] ${a.id} handed ${h.files.join(', ')} to ${h.to}, which has started.${notes ? `\nNotes: ${notes}` : ''}`);
    this.writeLedger();
    this.emitAgent(a);
    return { text: `Handed over. ${h.files.join(', ')} now belong to ${h.to}; don't edit them. If you need something there, message ${h.to}. Carry on with the rest of your piece.` };
  }

  // Hub notices to the orchestrator. Notices that arrive while it's busy are merged into one message.
  // An idle ORCH waits orchBatchSeconds (8) before waking, so reports landing close together cost one
  // turn instead of several (each turn re-sends ORCH's whole context). Free workers don't wait on this:
  // the queue dispatches without ORCH.
  // now: a worker is blocked on it (ticket, question), so it goes at once, taking anything held with it.
  notifyOrch(text, now = false) {
    const o = this.agents[ORCH];
    const waiting = o.queue.find(i => i.bundle);
    if (waiting) { waiting.text += '\n\n---\n\n' + text; return; }
    if (this.orchHold) {
      this.orchHold.text += '\n\n---\n\n' + text;
      if (!now) return;
      clearTimeout(this.orchHold.timer);
      text = this.orchHold.text;
      this.orchHold = null;
    }
    const wait = (this.cfg.orchBatchSeconds ?? 8) * 1000;
    if (now || !wait || o.busy) { o.send(text, { bundle: true, origin: 'hub' }); return; }
    const hold = this.orchHold = { text, timer: null };
    hold.timer = setTimeout(() => {
      if (this.orchHold !== hold) return;
      this.orchHold = null;
      o.send(hold.text, { bundle: true, origin: 'hub' });
    }, wait);
  }

  ownershipClash(id, paths, except = null) {
    for (const f of paths) {
      const k = this.norm(f);
      for (const [key, owner] of this.owners) {
        if (owner === id || owner === except || !this.assignments.has(owner)) continue;   // an idle worker's files can move; a split-off part sits inside its giver's folder
        if (key === k || this.ownerMatch(key, k) || this.ownerMatch(k, key)) return { owner, text: `${f} overlaps ${owner}'s files while ${owner} is working` };
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
      if (clash) throw new Error(clash.text + ' (use handoff to move part of a working worker\'s files)');
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
    this.stats.tickets = (this.stats.tickets || 0) + 1;
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
      this.notifyOrch(`[TICKET #${id} · ${kind.toUpperCase()} FROM ${a.id}${agents.length ? ` · involves ${agents.join(', ')}` : ''}${files.length ? ` · files: ${files.join(', ')}` : ''}]\n${summary}\n\n${a.id} is paused until you answer with mcp__cluster__rule (ticket ${id}).`, true);
    });
  }

  rule(p) {
    const t = this.tickets.get(p.ticket | 0);
    if (!t) throw new Error(`No open ticket #${p.ticket}. Open: ${[...this.tickets.keys()].join(', ') || 'none'}`);
    const decision = String(p.decision || '').trim();
    if (!decision) throw new Error('decision is required.');
    const granted = [];
    if (!t.from && (p.grant_files || []).length) throw new Error(`Ticket #${t.id} was raised by the hub, so there's nobody to grant files to. Use set_ownership or handoff.`);
    for (const f of p.grant_files || []) { this.owners.set(this.norm(f), t.from); granted.push(f); }
    const line = `- #${t.id} (${t.from ? `${t.from} ${t.kind}${t.agents.length ? ' with ' + t.agents.join(', ') : ''}` : `auto-flagged dispute, ${t.agents.join(', ')}`}): ${decision}`;
    this.ledger.Decisions = (this.ledger.Decisions ? this.ledger.Decisions + '\n' : '') + line;
    if (!t.from) {
      // Hub-raised ticket: nobody is paused, so both sides get the ruling as a message.
      for (const x of t.agents) this.deliver(ORCH, x, `ORCH RULING on #${t.id} (your back-and-forth with ${t.agents.filter(v => v !== x).join(', ')}): ${decision}\nThis is final and in the ledger. Make your side match it.`, 'ruling');
      for (const x of t.agents) this.chat(x, 'peer', decision, ORCH, 'ruling');
      t.resolve();
      this.writeLedger();
      return { text: `Ruled on #${t.id}; ${t.agents.join(' and ')} told. Recorded under Decisions.` };
    }
    this.chat(t.from, 'peer', decision, ORCH, 'ruling');
    this.logComms(ORCH, t.from, 'ruling', `#${t.id}: ${decision}`);
    // Everyone involved hears the ruling. A contract change reaches every working worker, since any of them may use it.
    const hear = t.kind === 'change' ? IDS.filter(x => x !== t.from && (t.agents.includes(x) || this.assignments.has(x))) : t.agents;
    for (const x of hear) this.deliver(ORCH, x, `${t.kind === 'change' ? 'CONTRACT CHANGE' : 'Ruling'} on ticket #${t.id} (raised by ${t.from}): ${decision}`, 'ruling');
    t.resolve({ text: `ORCH RULING on #${t.id}: ${decision}${granted.length ? `\nYou now own: ${granted.join(', ')}` : ''}\n(This is recorded in the ledger. Carry on.)` });
    this.writeLedger();
    return { text: `Ruled on #${t.id}; ${t.from} resumes${hear.length ? `, ${hear.join(', ')} notified` : ''}. Recorded under Decisions.` };
  }

  messageAgent(a, p) {
    const to = String(p.agent || '').toUpperCase();
    const text = String(p.message || '').trim();
    if (!text) throw new Error('message is required.');
    if (to === a.id) throw new Error('You cannot message yourself.');
    this.stats.msgs++;
    this.statOf(a.id).msgs++;
    // ALL: a one-line heads-up to every working worker (e.g. "my interface is ready").
    if (to === 'ALL') {
      const list = IDS.filter(x => x !== a.id && (this.assignments.has(x) || this.agents[x].busy));
      for (const x of list) this.deliver(a.id, x, text, 'message');
      return { text: list.length ? `Sent to ${list.join(', ')}.` : 'No other worker is working right now.' };
    }
    if (to === ORCH) {
      this.chat(ORCH, 'peer', text, a.id, 'message');
      this.logComms(a.id, ORCH, 'message', text);
      this.notifyOrch(`[MESSAGE FROM ${a.id}]\n${text}`);
      return { text: 'Sent to the orchestrator. If you need a decision before you can go on, use escalate instead (it waits for the answer).' };
    }
    if (!IDS.includes(to)) throw new Error('agent must be C1–C6 or ORCH.');
    this.deliver(a.id, to, text, 'message');
    this.watchChatter(a.id, to, text);
    const w = this.agents[to];
    const idle = !w.busy && !w.queue.length;
    return { text: idle
      ? `${to} is not working right now, so it will only see this on its next assignment. If you need an answer, escalate to the orchestrator.`
      : `Delivered to ${to}; it reads messages between steps. To wait for its answer, call read_messages with wait_seconds.` };
  }

  // Two workers going back and forth (many messages, or "final"/"revert" talk) is a dispute nobody
  // escalated. The hub opens a ticket for ORCH itself and asks both to hold that point until the ruling.
  watchChatter(x, y, text) {
    const pair = [x, y].sort(), key = pair.join('-'), now = Date.now();
    const list = (this.chatter.get(key) || []).filter(m => now - m.t < 10 * 60000);
    list.push({ from: x, text, t: now });
    this.chatter.set(key, list);
    if ([...this.tickets.values()].some(t => pair.every(id => id === t.from || t.agents.includes(id)))) return;
    const both = new Set(list.map(m => m.from)).size === 2;
    const heated = list.filter(m => /\bfinal\b|\brevert|\bundo|\bundid|\bdisagree|\bput (it )?back\b|\bchanged it back\b|\bthat'?s wrong\b|\bconflict/i.test(m.text)).length;
    if (!both || (list.length < (this.cfg.autoDisputeMessages || 8) && !(heated >= 2 && list.length >= 3))) return;
    this.chatter.delete(key);
    const id = ++this.ticketSeq;
    this.stats.autoTickets = (this.stats.autoTickets || 0) + 1;
    const mins = Math.max(1, Math.round((now - list[0].t) / 60000));
    const recent = list.slice(-6).map(m => `${m.from}: ${clip(m.text, 300)}`).join('\n');
    const summary = `Auto-flag: ${pair.join(' and ')} have traded ${list.length} messages in ${mins} min${heated ? ', with "final"/revert talk' : ''}. Looks like a disagreement nobody escalated.\nRecent:\n${recent}`;
    this.tickets.set(id, { id, from: null, kind: 'dispute', summary, agents: pair, files: [], t: now, resolve: () => this.tickets.delete(id) });
    this.chat(ORCH, 'peer', `#${id} DISPUTE (auto): ${pair.join(' ↔ ')}, ${list.length} messages in ${mins} min`, 'HUB', 'escalate');
    this.logComms(pair.join('+'), ORCH, 'escalate', `#${id} auto-flag`);
    for (const w of pair) this.deliver(ORCH, w, `Ticket #${id}: you and ${pair.find(v => v !== w)} have gone back and forth ${list.length} times, so ORCH has been asked to rule. Until the ruling arrives, don't change the point you're discussing again (and don't revert each other); work on other parts. The ruling will come as a message.`, 'notice');
    this.notifyOrch(`[TICKET #${id} · DISPUTE (raised by the hub) · involves ${pair.join(', ')}]\n${summary}\n\nRule with mcp__cluster__rule (ticket ${id}); both workers are told. If it isn't actually a disagreement, rule "no dispute, carry on".`);
    this.writeLedger();
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
    // Waiting is capped (maxWaitSeconds, default 20), and refused outright while the worker still has unstarted tasks.
    const wait = Math.max(0, Math.min(this.cfg.maxWaitSeconds ?? 20, Number(p.wait_seconds) || 0));
    const left = a.tasks.filter(t => t.status === 'pending').length;
    if (!this.mail[a.id].length && wait && left) {
      return { text: `No messages yet. You still have ${left} task(s) not started, so don't wait: carry on with them (code against the contract as written and note any assumption), and check messages again between steps.` };
    }
    if (!this.mail[a.id].length && wait) {
      await new Promise(res => {
        const done = () => { clearTimeout(timer); this.mailWaiters.delete(a.id); res(); };
        const timer = setTimeout(done, wait * 1000);
        this.mailWaiters.set(a.id, done);
      });
    }
    const box = this.mail[a.id].splice(0);
    if (!box.length) return { text: 'No messages.' };
    for (const h of this.handoffs.values()) if (h.from === a.id && box.some(m => m.kind === 'handoff' && m.text.startsWith(`[HANDOFF #${h.id} `))) h.notified = true;
    if (this.splitAsk?.from === a.id && box.some(m => m.kind === 'split')) this.splitAsk.notified = true;
    return { text: box.map(m => `From ${m.from} (${m.kind}): ${m.text}`).join('\n\n') };
  }

  logComms(from, to, kind, text) {
    this.comms.push({ from, to, kind, text: clip(text, 1500), t: Date.now() });
    if (this.comms.length > 400) this.comms.shift();
  }

  // ---- the queue: work ORCH lines up ahead of time; free workers start it without waiting for ORCH ----
  queueWork(p) {
    if (p.team_size !== undefined) this.teamSize = Math.max(1, Math.min(IDS.length, p.team_size | 0));
    const removed = [];
    for (const n of p.remove || []) {
      const i = this.backlog.findIndex(b => b.name === String(n) && b.state !== 'running');
      if (i >= 0) { this.backlog.splice(i, 1); removed.push(String(n)); }
    }
    const items = p.items || [];
    if (items.length) this.queueHeld = false;
    const { added, errors } = this.addItems(items);
    const warnings = added.length ? this.planWarnings() : [];
    this.dispatch();
    const started = this.autoStarted.splice(0);
    this.writeLedger();
    const lines = [];
    if (added.length) lines.push(`Queued: ${added.join(', ')}.`);
    if (removed.length) lines.push(`Removed: ${removed.join(', ')}.`);
    if (started.length) lines.push(`Started now: ${started.join(', ')}.`);
    if (errors.length) lines.push(`Not queued:\n- ${errors.join('\n- ')}`);
    if (warnings.length) lines.push(`Plan check:\n- ${warnings.join('\n- ')}`);
    if (p.integration_check !== undefined) {
      const cmd = String(p.integration_check || '').trim();
      this.integration = cmd ? { command: cmd, last: 0, failing: false, running: false } : null;
      lines.push(cmd ? `Integration check set: the hub runs "${cmd}" in the project folder every ${this.cfg.integrateEveryMinutes || 10} min while reports come in, and when the queue empties; you hear only about failures (and the first pass after one).` : 'Integration check turned off.');
    }
    lines.push(this.queueSummary() || 'The queue is empty.');
    lines.push('Free workers take ready items on their own (fresh session, your task and context as the briefing). Reports still come to you. Don\'t wait; end your turn unless you have more to do.');
    return { text: lines.join('\n') };
  }

  // Validate task cards and put them on the queue (queue_work and propose_work). by = the worker who proposed them.
  addItems(items, by = null) {
    const added = [], errors = [];
    const names = new Set([...this.backlog.map(b => b.name), ...items.map(t => String(t.name || '').trim())]);
    for (const t of items) {
      const name = String(t.name || '').trim(), task = String(t.task || '').trim();
      if (!name || !task) { errors.push(`${name || '(no name)'}: name and task are required`); continue; }
      const old = this.backlog.find(b => b.name === name);
      if (old?.state === 'running') { errors.push(`${name}: running on ${old.agent}; wait for its report`); continue; }
      if (old && by) { errors.push(`${name}: that name is already in the queue; pick another`); continue; }
      const after = [...new Set((t.after || []).map(String).filter(n => n && n !== name))];
      const unknown = after.filter(n => !names.has(n));
      if (unknown.length) { errors.push(`${name}: "after" names unknown item(s): ${unknown.join(', ')}`); continue; }
      const loop = after.find(n => this.waitsOn(n, name));
      if (loop) { errors.push(`${name}: waiting for "${loop}" would make a loop ("${loop}" already waits for "${name}")`); continue; }
      const item = { name, task, owns: t.review === true ? [] : (t.owns || []).map(String), context: String(t.context || ''), after, model: t.model ? String(t.model) : null, state: 'queued', agent: null, ...this.card(t) };
      // A review is a short report-only check: it owns nothing and never sits on the critical path.
      if (item.review) { item.priority = item.priority === 'critical' ? null : item.priority; item.waitForDone = true; }
      if (by) item.proposedBy = by;
      if (old) this.backlog[this.backlog.indexOf(old)] = item; else this.backlog.push(item);
      added.push(name);
    }
    if (added.length) this.markCritical();
    return { added, errors };
  }

  // A worker that discovers new work puts it on the queue itself (ORCH hears in one line and can remove it).
  // Its files must not belong to another working worker; items in the proposer's own files wait until it reports.
  proposeWork(a, p) {
    const items = (p.items || []).slice(0, 4);
    if (!items.length) throw new Error('items is required: one to four task cards (name, task, owns, ...).');
    const ok = [], errors = [];
    for (const t of items) {
      const clash = this.ownershipClash(a.id, (t.owns || []).map(String));
      if (CHECK_JOB_RE.test(String(t.name || ''))) errors.push(`${t.name}: tests and checks belong to the builder of that piece. If something fails in another worker's piece, message its owner with the failing input and output instead.`);
      else if (clash) errors.push(`${t.name || '(no name)'}: ${clash.text}. Message ${clash.owner} instead (it's that worker's piece).`);
      else ok.push(t);
    }
    const r = this.addItems(ok, a.id);
    errors.push(...r.errors);
    if (r.added.length) {
      this.queueHeld = false;
      this.stats.proposals = (this.stats.proposals || 0) + r.added.length;
      this.dispatch();
      this.logComms(a.id, ORCH, 'propose', r.added.join(', '));
      const desc = r.added.map(n => { const b = this.backlog.find(x => x.name === n); return `"${n}" (${b.task.split('\n')[0].slice(0, 80)})${b.state === 'running' ? ` → started on ${b.agent}` : ''}`; });
      this.notifyOrch(`[PROPOSED BY ${a.id}] queued ${desc.join('; ')}. Remove with queue_work remove if it's wrong.`);
      this.writeLedger();
    }
    const where = r.added.map(n => { const b = this.backlog.find(x => x.name === n); return b.state === 'running' ? `"${n}" started on ${b.agent}` : `"${n}" queued${this.ownershipClash('', b.owns)?.owner === a.id ? ' (it uses your files, so it starts once you report)' : ''}`; });
    return { text: `${where.length ? `${where.join('; ')}. Don't build it yourself; carry on with your own piece.` : 'Nothing queued.'}${errors.length ? `\nNot queued:\n- ${errors.join('\n- ')}` : ''}` };
  }

  // The worker doing a piece knows best what can be split off: it names files it owns, they leave its
  // ownership at once and become a queue item that a free worker starts right away. Work waiting on the
  // worker's item also waits on the split-off part.
  offerSplit(a, p) {
    const job = this.assignments.get(a.id);
    if (!job) throw new Error('You have no running assignment to split.');
    const asked = this.splitAsk?.from === a.id;
    if (asked) { clearTimeout(this.splitAsk.timer); this.splitAsk = null; }
    if (p.none) {
      this.splitDeclined[a.id] = Date.now();
      this.logComms(a.id, ORCH, 'split', `nothing separable: ${String(p.notes || '').slice(0, 200)}`);
      setImmediate(() => this.dispatch());
      return { text: 'Noted: nothing to split off. Carry on.' };
    }
    const files = (p.files || []).map(String).filter(Boolean);
    const task = String(p.task || '').trim();
    if (!files.length || !task) throw new Error('files and task are required (or none=true if nothing is separable).');
    for (const f of files) {
      const k = this.norm(f), o = this.owners.get(k) || this.ownerOf(k);
      if (o && o !== a.id) throw new Error(`${f} belongs to ${o}, not you. Only split off your own files.`);
    }
    // Move ownership and edit claims off the giver (same rule as hand_over).
    const keys = files.map(f => this.norm(f));
    const covered = k => keys.some(x => x === k || this.ownerMatch(x, k));
    for (const [k, v] of [...this.owners]) if (v === a.id && covered(k)) this.owners.delete(k);
    for (const [k, v] of [...this.claims]) if (v === a.id && covered(k)) this.claims.delete(k);
    job.owns = job.owns.filter(o => !covered(this.norm(o)));
    const notes = String(p.notes || '').trim();
    const parent = job.item && this.backlog.find(b => b.name === job.item);
    const name = `${job.item || a.id}-part${++this.splitSeq}`;
    const critical = parent?.priority === 'critical' || job.priority === 'critical' || (job.item && this.waitingOn(job.item) > 0);
    const item = {
      name, task, owns: files, after: [], state: 'queued', agent: null, splitFrom: a.id,
      context: `Split off by ${a.id} from its piece${job.item ? ` "${job.item}"` : ''}; ${a.id} is still building the rest and owns those files (message it for anything there).${notes ? `\n${a.id}'s notes:\n${notes}` : ''}${parent?.context ? `\n\nContext of the original piece:\n${parent.context}` : ''}`,
      ...this.card({ priority: critical ? 'critical' : null, done_when: p.done_when, provides: p.provides, est_minutes: p.est_minutes }),
    };
    item.model = this.tierModel(item);
    this.backlog.push(item);
    if (job.item) for (const b of this.backlog) if (b.state === 'queued' && b.after.includes(job.item)) b.after.push(name);
    this.markCritical();
    (job.handedOff ||= []).push(`${files.join(', ')} → "${name}"`);
    this.stats.splits = (this.stats.splits || 0) + 1;
    this.splitDeclined[a.id] = Date.now();   // don't ask it again straight away
    this.queueHeld = false;
    this.dispatch();
    const to = item.state === 'running' ? item.agent : null;
    this.logComms(a.id, ORCH, 'split', `"${name}" ${files.join(', ')}${to ? ` → ${to}` : ''}: ${task}`);
    this.notifyOrch(`[SPLIT] ${a.id} split off "${name}" (${files.join(', ')})${to ? `, started on ${to}` : ', queued for the next free worker'}: ${task.split('\n')[0].slice(0, 120)}`);
    this.writeLedger();
    this.emitAgent(a);
    return { text: `Split off as "${name}": ${files.join(', ')} ${to ? `now belong to ${to}, which has started` : 'are queued for the next free worker'}. Don't edit them any more; message ${to || 'their new owner'} if you need something there. Drop that work from your task list and carry on with the rest.` };
  }

  // A worker is free and the queue has nothing it can start: ask the busy worker with the longest timed chain
  // (own est + what waits on it; critical, then most unstarted tasks break ties) whether part of it can be split off.
  // Early split: a critical item estimated at 6+ minutes is asked once after splitMinWorkSeconds even if its task
  // list is short, unless a free worker could start another ready item instead. One ask at a time; a worker
  // that says "nothing" (or doesn't answer within splitAskSeconds) isn't asked again for splitCooldownSeconds.
  maybeAskSplit() {
    if (this.mode !== 'orch' || this.queueHeld || this.cfg.splitOffers === false || this.splitAsk) return;
    if (this.assignments.size >= this.teamSize) return;
    const free = IDS.filter(x => this.isFree(x));
    if (!free.length) return;
    const now = Date.now(), cool = (this.cfg.splitCooldownSeconds ?? 180) * 1000;
    const canStart = this.backlog.some(b => b.state === 'queued' && this.prereqsMet(b) && free.some(x => !this.ownershipClash(x, b.owns, b.splitFrom)));
    const memo = new Map();
    const pick = [...this.assignments].filter(([id, j]) => now - j.t >= (this.cfg.splitMinWorkSeconds ?? 60) * 1000
        && !(this.splitDeclined[id] > now - cool) && ![...this.handoffs.values()].some(h => h.from === id))
      .map(([id, j]) => ({ id, j, left: this.agents[id].tasks.filter(t => t.status === 'pending').length, d: j.item ? this.downstream(j.item, memo) : (j.estMinutes ?? 5), n: j.item ? this.waitingOn(j.item) : 0, crit: j.priority === 'critical' ? 1 : 0,
        early: j.priority === 'critical' && (j.estMinutes ?? 5) >= 6 && !j.earlyAsked && !canStart }))
      .filter(x => x.left >= 2 || x.early)
      .sort((x, y) => y.d - x.d || y.crit - x.crit || y.left - x.left)[0];
    if (!pick) return;
    const ask = this.splitAsk = { from: pick.id, t: now, notified: false };
    if (pick.early) pick.j.earlyAsked = true;
    ask.timer = setTimeout(() => {
      if (this.splitAsk !== ask) return;
      this.splitAsk = null;
      this.splitDeclined[pick.id] = Date.now();
      this.dispatch();
    }, (this.cfg.splitAskSeconds ?? 90) * 1000);
    ask.text = `[SPLIT REQUEST FROM THE HUB] ${free.join(', ')} ${free.length > 1 ? 'are' : 'is'} free and nothing in the queue can start${pick.n ? `; ${pick.n} queued item(s) wait on your piece` : ''}${pick.crit ? `; your piece is on the critical path (about ${Math.round(pick.d)} min with what waits on it)` : ''}. You know your piece best: if part of what's left can be built separately (another module, a page, sibling functions) and is worth at least ~5 minutes of work (a fresh worker spends ~2–3 minutes getting oriented), split it off now. Tests stay with you. Bring those files to a working state, then call mcp__cluster__offer_split with files (yours, not ones you're mid-edit on), task, notes and done_when; it starts on a free worker at once. If nothing is separable right now (tightly linked, nearly done, a tricky debug), call offer_split with none=true. Decide in a minute; don't plan it at length.`;
    this.deliver(ORCH, pick.id, ask.text, 'split');
    this.logComms(ORCH, pick.id, 'split', 'asked to split off work for ' + free.join(', '));
  }

  // "My interface is final": items waiting on this one start now (unless they set wait_for_done), and every
  // working worker hears it. The rest of the piece goes on; its report still marks the item done.
  markReady(a, p) {
    const job = this.assignments.get(a.id);
    if (!job) throw new Error('You have no running assignment.');
    const summary = String(p.summary || '').trim();
    if (!summary) throw new Error('summary is required: the exports/endpoints others use and the files they are in.');
    const item = job.item && this.backlog.find(b => b.name === job.item && b.agent === a.id);
    if (item) { item.interfaceReady = clip(summary, 1500); item.readyAt = Date.now(); }
    const label = `${a.id}${item ? ` ("${item.name}")` : ''}`;
    for (const id of this.assignments.keys()) if (id !== a.id) this.deliver(a.id, id, `[INTERFACE READY] ${label}: ${summary}`, 'message');
    this.stats.readyMarks = (this.stats.readyMarks || 0) + 1;
    this.logComms(a.id, 'ALL', 'ready', summary);
    const before = new Set(this.backlog.filter(b => b.state === 'running').map(b => b.name));
    this.dispatch();
    const started = item ? this.backlog.filter(b => b.state === 'running' && !before.has(b.name) && b.after.includes(item.name)).map(b => `"${b.name}" on ${b.agent}`) : [];
    if (started.length) this.notifyOrch(`[INTERFACE READY] ${label}: dependent work started early: ${started.join(', ')}.`);
    return { text: `Marked ready and announced to the working workers.${started.length ? ` Started on it now: ${started.join(', ')}.` : ''} Keep that interface stable from here: changing it is a "change" escalation. Carry on with the rest of your piece.` };
  }

  // A working worker's task-list progress, for the load board and cluster_status.
  taskProgress(id) {
    const x = this.agents[id];
    if (!x.tasks.length) return ' · no task list yet';
    const done = x.tasks.filter(t => t.status === 'completed').length;
    const left = x.tasks.filter(t => t.status !== 'completed').map(t => (t.status === 'in_progress' ? '▶ ' : '') + t.text);
    return ` · tasks ${done}/${x.tasks.length}${left.length ? ` · left: ${left.join('; ').slice(0, 400)}` : ''}`;
  }

  // Model tiers: a model ORCH names wins; otherwise critical-path items get criticalModel (empty = the
  // default model) and everything else workerModel (empty = the default model).
  tierModel(t) {
    if (t.model) return String(t.model);
    return (t.priority === 'critical' ? this.cfg.criticalModel : this.cfg.workerModel) || null;
  }

  // The short task-card fields an item or assignment may carry besides name/task/owns/after.
  card(t) {
    const priority = ['critical', 'filler'].includes(t.priority) ? t.priority : null;
    const est = Number(t.est_minutes ?? t.estMinutes);
    return { provides: (t.provides || []).map(String).filter(Boolean), doneWhen: String(t.done_when || '').trim(), priority, waitForDone: t.wait_for_done === true, review: t.review === true, estMinutes: est > 0 ? est : 5 };
  }

  // Does queue item `from` wait (directly or through others) for item `target`?
  waitsOn(from, target, seen = new Set()) {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (this.backlog.find(b => b.name === from)?.after || []).some(n => this.waitsOn(n, target, seen));
  }

  // Timed chain: this item's own est_minutes plus the longest chain (in estimated minutes) of unfinished
  // items waiting on it, directly or not. The longer it is, the sooner the item should start.
  downstream(name, memo = new Map(), seen = new Set()) {
    if (memo.has(name)) return memo.get(name);
    const self = this.backlog.find(b => b.name === name);
    let behind = 0;
    seen.add(name);
    for (const b of this.backlog) {
      if (b.state === 'done' || seen.has(b.name) || !b.after.includes(name)) continue;
      behind = Math.max(behind, this.downstream(b.name, memo, seen));
    }
    seen.delete(name);
    const d = (self ? self.estMinutes ?? 5 : 0) + behind;
    memo.set(name, d);
    return d;
  }

  // How many unfinished items wait on this one, directly or not.
  waitingOn(name) {
    return this.backlog.filter(b => b.state !== 'done' && b.name !== name && this.waitsOn(b.name, name)).length;
  }

  // The longest timed chain of unfinished items gets priority "critical" (only items with no label; labels are
  // never removed). Recomputed when items are added, split off or finish. A lone item with nothing behind it
  // isn't a chain and stays as it is.
  markCritical() {
    const open = this.backlog.filter(b => b.state !== 'done');
    const isOpen = n => open.some(o => o.name === n);
    const memo = new Map();
    const best = list => list.reduce((x, y) => (!x || this.downstream(y.name, memo) > this.downstream(x.name, memo) ? y : x), null);
    let cur = best(open.filter(b => !b.after.some(isOpen)));
    const chain = [];
    while (cur && !chain.includes(cur)) { chain.push(cur); cur = best(open.filter(b => b.after.includes(cur.name))); }
    if (chain.length < 2) return [];
    const marked = [];
    for (const b of chain) {
      if (b.priority || b.review) continue;
      b.priority = 'critical'; b.autoCritical = true; marked.push(b.name);
      const job = b.state === 'running' && this.assignments.get(b.agent);
      if (job && job.item === b.name) job.priority = 'critical';
    }
    return marked;
  }

  // Cheap pre-dispatch review of the queue: hidden file clashes and bottlenecks.
  planWarnings() {
    const open = this.backlog.filter(b => b.state !== 'done');
    const out = [];
    for (let i = 0; i < open.length; i++) {
      for (const y of open.slice(i + 1)) {
        const x = open[i];
        if (this.waitsOn(x.name, y.name) || this.waitsOn(y.name, x.name)) continue;
        const hit = x.owns.find(f => y.owns.some(g => { const a = this.norm(f), b = this.norm(g); return a === b || this.ownerMatch(a, b) || this.ownerMatch(b, a); }));
        if (hit) out.push(`"${x.name}" and "${y.name}" both own ${hit} and neither waits for the other, so they will run one after the other. Split the files, or add after if that order is intended.`);
      }
    }
    for (const x of open) {
      const n = open.filter(b => b.after.includes(x.name)).length;
      if (n >= 3) out.push(`${n} items wait on "${x.name}". If it is big, split it so they can start sooner (or mark it priority "critical").`);
    }
    for (const x of open) {
      if (!x.review && CHECK_JOB_RE.test(x.name)) out.push(`"${x.name}" looks like a separate test/verify/audit job. Builders write and run the tests for their own piece and check it against its spec sections, so drop it (queue_work remove) unless it builds something real. For a light spot check use one item with review=true.`);
    }
    const reviews = open.filter(b => b.review);
    if (reviews.length > 1) out.push(`${reviews.length} review items (${reviews.map(b => b.name).join(', ')}). One short review is enough; fold the rest into it.`);
    const width = open.filter(b => !b.review && !b.after.length).length;
    if (this.teamSize > width && width && this.teamSize < IDS.length) out.push(`team_size is ${this.teamSize} but only ${width} item(s) can run at once now. That's fine (idle workers cost nothing); don't invent work to fill the rest.`);
    return out;
  }

  // ORCH's stop tool: halt workers at once (no report), free their files, park or clear the queue.
  stopWorkers(p) {
    const ids = (p.agents?.length ? p.agents : IDS).map(String);
    const bad = ids.filter(x => !IDS.includes(x));
    if (bad.length) throw new Error(`Not a worker: ${bad.join(', ')}. Use C1–C6.`);
    const all = IDS.every(x => ids.includes(x));
    const clear = p.clear_queue !== false;
    const stopped = [];
    for (const id of ids) {
      const w = this.agents[id], job = this.assignments.get(id);
      const active = w.busy || w.queue.length || job;
      // Drop the assignment first, so the killed turn never turns into a [REPORT].
      if (job) {
        this.assignments.delete(id);
        const rec = this.stats.jobs.findLast(j => j.agent === id && j.t === job.t);
        if (rec) rec.end = Date.now();
        const item = job.item && this.backlog.find(b => b.name === job.item && b.agent === id);
        if (item) { item.state = 'stopped'; item.agent = null; }
      }
      for (const h of [...this.handoffs.values()]) if (h.from === id || h.to === id) this.endHandoff(h);
      if (this.splitAsk?.from === id) { clearTimeout(this.splitAsk.timer); this.splitAsk = null; }
      for (const t of [...this.tickets.values()]) if (t.from === id) t.resolve({ text: '[stopped by ORCH]' });
      this.mail[id] = [];
      this.mailWaiters.get(id)?.();
      w.halt('[stopped by ORCH]');
      w.connected.delete(ORCH); this.agents[ORCH].connected.delete(id);
      this.setLink(ORCH, id, false);
      this.releaseAll(id);
      this.freeSince[id] = Date.now();
      if (active) {
        stopped.push(`${id}${job ? ` (was on${job.item ? ` "${job.item}":` : ''} ${job.task.split('\n')[0].slice(0, 80)})` : ''}`);
        this.sys(id, 'Stopped by ORCH.');
      }
      this.emitAgent(w);
    }
    let cleared = 0;
    if (clear) { cleared = this.backlog.filter(b => b.state !== 'done').length; this.backlog = this.backlog.filter(b => b.state === 'done'); }
    if (all) { this.integration = null; if (!clear) this.queueHeld = true; }
    this.logComms(ORCH, ids.join(','), 'stop', stopped.join('; ') || 'nobody was working');
    this.writeLedger();
    if (!all) this.dispatch();
    const lines = [`Stopped: ${stopped.join('; ') || `nobody was working (${ids.join(', ')} now idle)`}. They are idle; their files are free to reassign.`];
    if (clear) lines.push(cleared ? `Queue cleared (${cleared} unfinished item(s) removed).` : 'Queue was already empty.');
    else lines.push((this.queueSummary() || 'The queue is empty.') + (all ? ' Queue is held: nothing auto-starts until you add work with queue_work.' : ' Stopped items stay stopped; re-queue them by name to restart.'));
    if (all) lines.push('Integration check turned off.');
    return { text: lines.join('\n') };
  }

  // Start queued items on free workers: everything they wait for is done, no file clash, within the team size.
  // Order: priority "critical" first, then the item with the longest chain waiting behind it, "filler" last.
  // Worker: prefer the free worker that built what the item builds on (it knows that code).
  dispatch() {
    if (this.mode !== 'orch' || this.queueHeld) return;
    this.dispatchQueue();
    this.maybeAskSplit();
  }

  dispatchQueue() {
    if (!this.backlog.length) return;
    const rank = b => ({ critical: 0, filler: 2 }[b.priority] ?? 1);
    const ready = this.backlog.filter(b => b.state === 'queued' && this.prereqsMet(b))
      .map((b, i) => ({ b, i, d: this.downstream(b.name) }))
      .sort((x, y) => rank(x.b) - rank(y.b) || y.d - x.d || x.i - y.i).map(x => x.b);
    let started = false;
    for (const item of ready) {
      if (this.assignments.size >= this.teamSize) break;
      const free = IDS.filter(x => this.isFree(x) && !this.ownershipClash(x, item.owns, item.splitFrom));
      if (!free.length) continue;
      // Prefer the worker whose area this is (it built what the item builds on, or worked on its files).
      const score = x => this.related(this.agents[x], item);
      const id = free.reduce((best, x) => (score(x) > score(best) ? x : best), free[0]);
      const w = this.agents[id];
      // That worker keeps its session (it already knows the code) unless its memory has grown large.
      // It keeps that session's model too, unless the item names one; otherwise the item gets its tier's model.
      const canKeep = this.canKeep(w, item);
      const model = item.model || (canKeep ? (w.jobModel || null) : this.tierModel(item));
      const keep = canKeep && (model || null) === (w.jobModel || null);
      const job = this.recordJob(w, item.task, item.owns, { model, item: item.name, continued: keep, provides: item.provides, doneWhen: item.doneWhen, priority: item.priority, review: item.review, estMinutes: item.estMinutes });
      item.state = 'running';
      item.agent = id;
      this.autoStarted.push(`"${item.name}" → ${id}${keep ? ' (same session)' : ''}`);
      this.startJob(w, job, item.context, !keep);
      started = true;
    }
    if (started) this.writeLedger();
  }

  // Integrate early: ORCH's integration_check (e.g. the full build + tests) runs in the shared check queue
  // every integrateEveryMinutes while reports come in, and once when the queue empties. ORCH hears only
  // about failures, and about the first pass after a failure.
  maybeIntegrate() {
    const ic = this.integration;
    if (!ic || ic.running || this.mode !== 'orch') return;
    const finished = !this.assignments.size && !this.backlog.some(b => b.state !== 'done');
    if (!finished && Date.now() - ic.last < (this.cfg.integrateEveryMinutes || 10) * 60000) return;
    ic.running = true;
    ic.last = Date.now();
    const env = { ...process.env };
    if (this.cfg.auth === 'subscription') delete env.ANTHROPIC_API_KEY;
    this.feed(ORCH, 'run', `INTEGRATION CHECK $ ${ic.command}`);
    this.checks.run(ic.command, this.workspace, env).then(r => {
      ic.running = false;
      if (this.integration !== ic) return;
      const ok = /^Exit code 0\b/.test(r.text);
      this.stats.integrations = (this.stats.integrations || 0) + 1;
      if (!ok) this.stats.integrationFails = (this.stats.integrationFails || 0) + 1;
      // The final run (nothing running or queued) always reports, so ORCH can wrap up without re-running it.
      const final = !this.assignments.size && !this.backlog.some(b => b.state !== 'done');
      if (ok && !ic.failing && !final) return;
      ic.failing = !ok;
      const told = ok ? [] : this.routeFailure(r.text);
      this.notifyOrch(ok
        ? `[INTEGRATION CHECK PASSED] "${ic.command}" ${final ? 'passes with all work done. This is your final verification: don\'t re-run it, give the operator the short summary.' : 'passes again.'}\n${final ? clip(r.text, 800) : ''}`
        : `[INTEGRATION CHECK FAILED] "${ic.command}"\n${clip(r.text, 3000)}\n\n${told.length ? `The hub already sent the output to the working owner(s) of the failing files: ${told.join(', ')}. Don't repeat it to them. ` : ''}Send each other failure to the worker that owns the failing files, as a priority "critical" item (queue_work; that worker keeps its memory for work in its own files) or a quick follow-up (assign). Never give it to a different worker to debug. Failures inside files a worker is still building may just be work in progress: tell that worker rather than re-queueing.`);
    });
  }

  // Integration failed: find owned files named in the output and send it to their owners that are still
  // working (they read it between steps). Returns who was told; free owners are left to ORCH to re-queue.
  routeFailure(out) {
    const low = String(out).toLowerCase().replace(/\\/g, '/');
    const hit = new Map();
    for (const [k, owner] of this.owners) {
      if (k.includes('*') || !path.extname(k) || !this.assignments.has(owner)) continue;
      const rel = path.relative(this.workspace, k).toLowerCase().replace(/\\/g, '/');
      const base = path.basename(k).toLowerCase();
      if (low.includes(rel) || new RegExp(`(^|[\\s/("'])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(low)) (hit.get(owner) || hit.set(owner, []).get(owner)).push(path.basename(k));
    }
    for (const [owner, files] of hit) this.deliver(ORCH, owner, `[INTEGRATION CHECK FAILED] in your files (${[...new Set(files)].join(', ')}). Fix it as part of your piece:\n${clip(out, 2000)}`, 'message');
    return [...hit.keys()];
  }

  // An item can start once every item it waits for is done, or (unless it set wait_for_done) has marked
  // its interface ready.
  prereqsMet(item) {
    return item.after.every(n => {
      const b = this.backlog.find(x => x.name === n);
      return b && (b.state === 'done' || (!item.waitForDone && b.state === 'running' && b.interfaceReady));
    });
  }

  queueSummary() {
    if (!this.backlog.length) return '';
    const done = n => this.backlog.find(b => b.name === n)?.state === 'done';
    const by = st => this.backlog.filter(b => b.state === st);
    const queued = by('queued'), running = by('running');
    const ready = queued.filter(b => this.prereqsMet(b)), waiting = queued.filter(b => !this.prereqsMet(b));
    const list = (arr, f) => (arr.length ? ` (${arr.map(f).join(', ')})` : '');
    return `QUEUE (team size ${this.teamSize}): ${running.length} running${list(running, b => `${b.name} on ${b.agent}${b.interfaceReady ? ', interface ready' : ''}`)}, ${ready.length} ready${list(ready, b => b.name)}, ${waiting.length} waiting${list(waiting, b => `${b.name} after ${b.after.filter(n => !done(n)).join('+')}`)}, ${by('done').length} done${by('stopped').length ? `, ${by('stopped').length} stopped${list(by('stopped'), b => b.name)}` : ''}.${!queued.length && !running.length ? ' Nothing left in the queue.' : ''}`;
  }

  // ---- check: shared type checker and a queue for heavy commands (tests, builds) ----
  async check(a, p) {
    const dir = path.resolve(this.workspace, String(p.folder || '.'));
    if (!(dir.toLowerCase() + path.sep).startsWith(this.workspace.toLowerCase() + path.sep)) throw new Error('folder must be inside the project.');
    if (!fs.existsSync(dir)) throw new Error(`No folder ${p.folder} in the project.`);
    if (p.kind !== 'run') {
      const r = await this.checks.types(dir, (p.files || []).map(String));
      return r || { text: `No shared type checker for ${p.folder || 'the project folder'}: it needs tsconfig.json and typescript installed (node_modules/typescript) in that folder. Pass folder, or use kind "run" with your check command.` };
    }
    const cmd = String(p.command || '').trim();
    if (!cmd) throw new Error('command is required for kind "run".');
    const env = { ...process.env, CT_AGENT: a.id };
    const ports = this.portRange(a.id);
    if (ports) { env.PORT = String(ports[0]); env.CT_PORTS = `${ports[0]}-${ports[1]}`; }
    if (this.cfg.auth === 'subscription') delete env.ANTHROPIC_API_KEY;
    this.feed(a.id, 'run', `CHECK $ ${cmd}`);
    return this.checks.run(cmd, dir, env);
  }

  // The guard as an HTTP hook: same rules as hook-guard.js. An empty reply lets the tool run.
  hookReply(headers, body) {
    try {
      const a = this.agents[headers['x-ct-agent']];
      if (headers['x-ct-token'] !== this.token || !a) return '';
      const ev = JSON.parse(body);
      const ti = ev.tool_input || {};
      const file = ti.file_path || ti.notebook_path;
      const command = /^(Bash|PowerShell)$/.test(ev.tool_name || '') ? ti.command : null;
      if (!file && !command) return '';
      const r = this.guard(a, { file, command, cwd: ev.cwd });
      if (r.allow !== false) return '';
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.reason } });
    } catch {
      return '';
    }
  }

  // ---- spec prep: a PDF named in an orch instruction becomes text in .cluster/spec/ before ORCH starts ----
  prepSpec(text) {
    const found = new Map();
    const add = f => { const k = path.resolve(this.workspace, f); if (/\.pdf$/i.test(k) && fs.existsSync(k)) found.set(k.toLowerCase(), k); };
    for (const m of text.matchAll(/[a-z]:[\\/][^\n"<>|*?]*?\.pdf(?![a-z0-9])/gi)) add(m[0]);
    for (const m of text.matchAll(/(?:^|[\s"'(])([^\s"'<>|*?:]+\.pdf)(?![a-z0-9])/gim)) add(m[1]);
    // A folder named instead of the PDF (as in the Relay race): convert the PDFs at its top level.
    if (!found.size) {
      for (const dir of this.namedFolders(text)) {
        try { fs.readdirSync(dir).filter(n => /\.pdf$/i.test(n)).slice(0, 3).forEach(n => add(path.join(dir, n))); } catch {}
      }
    }
    const notes = [];
    for (const f of found.values()) {
      try { notes.push(this.pdfToText(f)); } catch (e) { notes.push(`Could not convert ${f} to text (${e.message.split('\n')[0]}); read it yourself.`); }
    }
    return notes.length ? `\n\n[CLUSTER TERMINAL NOTE]\n${notes.join('\n')}\nRead the text, never the PDF. Get work out within about a minute: skim the headings, write contracts.md, then queue setup and the first wave together (builders don't wait for setup).` : '';
  }

  pdfToText(f) {
    const dir = path.join(this.workspace, '.cluster', 'spec');
    fs.mkdirSync(dir, { recursive: true });
    const name = 'source-' + (path.basename(f, path.extname(f)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'spec') + '.txt';
    const out = path.join(dir, name);
    if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(f).mtimeMs) {
      if (this.pdftotext) execFileSync(this.pdftotext, ['-layout', '-enc', 'UTF-8', f, out], { timeout: 120000, windowsHide: true });
      else execFileSync('python', ['-I', '-c', 'import sys, pypdf\nr = pypdf.PdfReader(sys.argv[1])\nopen(sys.argv[2], "w", encoding="utf-8").write("\\f".join((p.extract_text() or "") for p in r.pages))', f, out], { timeout: 120000, windowsHide: true });
    }
    const txt = fs.readFileSync(out, 'utf8');
    const pages = txt.split('\f').filter(s => s.trim()).length;
    return `${f} has already been converted to plain text: ${path.join(dir, name)} (${pages} pages, ${txt.length.toLocaleString()} characters).`;
  }

  // Folders named in an instruction: absolute paths (spaces allowed; the longest prefix that is a real
  // folder wins) and quoted names relative to the project.
  namedFolders(text) {
    const dirs = new Map();
    const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
    const add = p => { if (isDir(p)) dirs.set(path.resolve(p).toLowerCase(), path.resolve(p)); };
    for (const m of text.matchAll(/[a-z]:[\\/][^\n"<>|*?]*/gi)) {
      const words = m[0].split(' ');
      for (let n = words.length; n > 0; n--) {
        const p = words.slice(0, n).join(' ').replace(/[.,;:!?)'`]+$/, '');
        if (isDir(p)) { add(p); break; }
      }
    }
    for (const m of text.matchAll(/["'`]([^"'`\n<>|*?]+)["'`]/g)) add(path.resolve(this.workspace, m[1]));
    return [...dirs.values()];
  }

  // The project's own CLAUDE.md (lean agents skip CLAUDE.md discovery, which would also load the operator's
  // personal rules from parent folders).
  projectRules() {
    try {
      const t = fs.readFileSync(path.join(this.workspace, 'CLAUDE.md'), 'utf8').trim();
      return t ? `\n\nPROJECT RULES (the project's CLAUDE.md):\n${clip(t, 6000)}` : '';
    } catch { return ''; }
  }

  // ---- run stats (/stats): where each agent's time went since the run started ----
  resetStats() {
    this.stats = { t0: null, agents: {}, jobs: [], msgs: 0 };
    this.pendingTools = new Map();
  }

  statOf(id) { return (this.stats.agents[id] ||= { busy: 0, turns: 0, cat: {}, firstEdit: null, lastEnd: null, out: 0, msgs: 0 }); }

  statCategory(n, i) {
    if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(n)) return 'write';
    if (n === 'Read') return /\.pdf$/i.test(i.file_path || '') || /[\\/]\.cluster[\\/]spec[\\/]/i.test(i.file_path || '') ? 'spec' : 'read';
    if (n === 'Glob' || n === 'Grep') return 'read';
    if (n === 'Bash' || n === 'PowerShell') {
      const c = i.command || '';
      if (isHeavy(c)) return 'build/test';
      if (/\.pdf\b|pdftotext|pypdf/i.test(c)) return 'spec';
      return 'shell';
    }
    if (n === 'mcp__cluster__check') return 'build/test';
    if (/^mcp__cluster__(read_messages|escalate|ask_agent)$/.test(n)) return 'waiting';
    return 'other';
  }

  statTool(a, b) {
    this.pendingTools.set(b.id, { id: a.id, cat: this.statCategory(b.name, b.input || {}), t: Date.now() });
    if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(b.name)) {
      this.statOf(a.id).firstEdit ||= Date.now();
      // Ramp-up: how long each assignment took from start to its first edit.
      const job = this.stats.jobs.findLast(j => j.agent === a.id && !j.end);
      if (job) job.firstEdit ||= Date.now();
    }
  }

  statToolDone(a, toolId) {
    const p = this.pendingTools.get(toolId);
    if (!p) return;
    this.pendingTools.delete(toolId);
    const s = this.statOf(p.id);
    s.cat[p.cat] = (s.cat[p.cat] || 0) + (Date.now() - p.t);
  }

  statTurn(a) {
    const s = this.statOf(a.id);
    s.turns++;
    s.busy += Date.now() - (a.turnT || Date.now());
    s.lastEnd = Date.now();
  }

  statsText() {
    const st = this.stats;
    if (!st.t0) return 'RUN STATS: nothing yet. The clock starts at the first instruction after /clearall, a mode switch or /stats reset.';
    const min = ms => (ms / 60000).toFixed(1) + 'm';
    const at = t => { if (!t) return '—'; const s = Math.round((t - st.t0) / 1000); return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    const hm = t => new Date(t).toTimeString().slice(0, 8);
    const cats = ['build/test', 'waiting', 'spec', 'read', 'write', 'shell', 'other'];
    const ids = [ORCH, ...IDS].filter(id => st.agents[id]?.turns);
    const lastEnd = Math.max(0, ...ids.map(id => st.agents[id].lastEnd || 0));
    const busyNow = ids.some(id => this.agents[id].busy);
    const out = [`RUN STATS · started ${hm(st.t0)} · ${busyNow ? `${min(Date.now() - st.t0)} so far (still running)` : `last agent finished at ${at(lastEnd)}`}`];
    const total = {};
    for (const id of ids) {
      const s = st.agents[id];
      const tools = cats.reduce((n, c) => n + (s.cat[c] || 0), 0);
      for (const c of cats) total[c] = (total[c] || 0) + (s.cat[c] || 0);
      const parts = [`busy ${min(s.busy)}`, `thinking ${min(Math.max(0, s.busy - tools))}`, ...cats.filter(c => s.cat[c] >= 1000).map(c => `${c} ${min(s.cat[c])}`)];
      out.push(`\n${id}  ${parts.join(' · ')}\n    first edit ${at(s.firstEdit)} · finished ${at(s.lastEnd)} · ${s.turns} turn(s) · ${s.msgs} msgs sent · ${Math.round(s.out / 1000)}k tokens out`);
    }
    if (st.jobs.length) {
      out.push('\nASSIGNMENTS (minutes from the start)');
      for (const j of st.jobs) out.push(`${j.agent}  ${at(j.t)} → ${j.end ? at(j.end) : 'running'}${j.end ? ` (${min(j.end - j.t)})` : ''}  ${j.item ? `[${j.item}] ` : ''}${j.task}`);
    }
    const workers = ids.filter(id => id !== ORCH);
    const firstEdit = Math.min(...workers.map(id => st.agents[id].firstEdit || Infinity));
    const ends = workers.map(id => st.agents[id].lastEnd).filter(Boolean).sort((x, y) => x - y);
    out.push('\nTOTALS');
    out.push(`Across all agents: ${cats.filter(c => total[c] >= 1000).map(c => `${c} ${min(total[c])}`).join(' · ') || 'no tool time yet'}`);
    if (isFinite(firstEdit)) out.push(`First code written at ${at(firstEdit)}.`);
    if (ends.length > 1) out.push(`Workers finished between ${at(ends[0])} and ${at(ends.at(-1))} (spread ${min(ends.at(-1) - ends[0])}).`);
    out.push(`Messages between agents: ${st.msgs}.`);
    const m = this.metrics();
    if (m) {
      const s = v => (v == null ? '—' : `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`);
      out.push(`Planning (instruction → first assignment) ${s(m.planningSeconds)} · first edit ${s(m.timeToFirstEditSeconds)} · ramp-up (assignment → first edit) median ${s(m.rampUpMedianSeconds)}.`);
      if (m.idleShare != null) out.push(`Idle share of workers that took work: ${Math.round(m.idleShare * 100)}%.`);
      out.push(`Tickets ${m.tickets} (+${m.autoTickets} raised by the hub) · handoffs ${m.handoffs} · splits ${m.splits} · proposed items ${m.proposals} · interfaces marked ready ${m.readyMarks} · integration checks ${m.integrationChecks} (${m.integrationFailures} failed) · assignments done ${m.itemsDone}${m.outputTokensPerItem != null ? ` · ${Math.round(m.outputTokensPerItem / 1000)}k tokens out per assignment` : ''}.`);
    }
    out.push('(Thinking = busy time not spent in tools. Tools that ran side by side are counted separately, so the parts can add up to more than busy.)');
    return out.join('\n');
  }

  writeStatsFile() {
    try {
      const dir = path.join(this.workspace, '.cluster');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'stats.md'), '```\n' + this.statsText() + '\n```\n');
      // One metrics.json per run (named by its start time), so runs can be compared on numbers.
      const m = this.metrics();
      if (m) {
        const run = path.join(dir, 'runs', new Date(this.stats.t0).toISOString().slice(0, 19).replace(/[:T]/g, '-'));
        fs.mkdirSync(run, { recursive: true });
        fs.writeFileSync(path.join(run, 'metrics.json'), JSON.stringify(m, null, 2) + '\n');
      }
    } catch {}
  }

  // The numbers for comparing runs (seconds, counts, tokens).
  metrics() {
    const st = this.stats;
    if (!st.t0) return null;
    const sec = ms => (ms == null || !isFinite(ms) ? null : Math.round(ms / 1000));
    const now = Date.now();
    const workers = IDS.filter(id => st.agents[id]?.turns);
    const firstEdit = Math.min(...workers.map(id => st.agents[id].firstEdit || Infinity));
    const ends = [ORCH, ...IDS].map(id => st.agents[id]?.lastEnd || 0);
    const runEnd = [ORCH, ...IDS].some(id => this.agents[id].busy) ? now : Math.max(st.t0, ...ends);
    const ramps = st.jobs.filter(j => j.firstEdit).map(j => j.firstEdit - j.t).sort((x, y) => x - y);
    // Idle: from the first assignment to the last job end, the time each worker that took work had none.
    let idleShare = null;
    if (st.jobs.length) {
      const from = Math.min(...st.jobs.map(j => j.t)), to = Math.max(...st.jobs.map(j => j.end || now));
      const ids = [...new Set(st.jobs.map(j => j.agent))];
      if (to > from) {
        const busy = ids.reduce((n, id) => n + st.jobs.filter(j => j.agent === id).reduce((s, j) => s + Math.max(0, Math.min(j.end || now, to) - Math.max(j.t, from)), 0), 0);
        idleShare = Math.max(0, Math.round((1 - busy / (ids.length * (to - from))) * 1000) / 1000);
      }
    }
    const out = Object.values(st.agents).reduce((n, a) => n + (a.out || 0), 0);
    const itemsDone = st.jobs.filter(j => j.end).length;
    return {
      started: new Date(st.t0).toISOString(),
      totalSeconds: sec(runEnd - st.t0),
      planningSeconds: st.jobs.length ? sec(st.jobs[0].t - st.t0) : null,
      timeToFirstEditSeconds: sec(firstEdit - st.t0),
      rampUpMedianSeconds: ramps.length ? sec(ramps[ramps.length >> 1]) : null,
      idleShare,
      tickets: st.tickets || 0,
      autoTickets: st.autoTickets || 0,
      handoffs: st.handoffs || 0,
      splits: st.splits || 0,
      proposals: st.proposals || 0,
      readyMarks: st.readyMarks || 0,
      integrationChecks: st.integrations || 0,
      integrationFailures: st.integrationFails || 0,
      messages: st.msgs,
      itemsDone,
      outputTokens: out,
      outputTokensPerItem: itemsDone ? Math.round(out / itemsDone) : null,
      items: st.jobs.map(j => {
        const b = j.item && this.backlog.find(x => x.name === j.item);
        return { name: j.item || j.task, agent: j.agent, model: j.model || null, est_minutes: j.est ?? b?.estMinutes ?? null, actual_minutes: j.end ? Math.round((j.end - j.t) / 6000) / 10 : null, critical: !!(j.critical || b?.priority === 'critical') };
      }),
      perAgent: Object.fromEntries(Object.entries(st.agents).map(([id, a]) => [id, { busySeconds: sec(a.busy), turns: a.turns, outputTokens: a.out, firstEditSeconds: a.firstEdit ? sec(a.firstEdit - st.t0) : null }])),
    };
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

## Queue (automatic)
${this.backlog.map(b => `- ${b.name} [${b.state}${b.agent ? ' on ' + b.agent : ''}${b.by && !b.agent ? ' by ' + b.by : ''}${b.priority ? ', ' + b.priority : ''}]${b.after.length ? ` after ${b.after.join(', ')}` : ''}: ${b.task.split('\n')[0].slice(0, 120)}`).join('\n') || '- (empty)'}

## Open tickets (automatic)
${[...this.tickets.values()].map(t => `- #${t.id} ${t.kind} from ${t.from || 'hub (' + t.agents.join(', ') + ')'}: ${t.summary.slice(0, 200)}`).join('\n') || '- (none)'}
`;
  }

  // The spec sections ORCH saved in <project>/.cluster/spec/ (listed in every briefing).
  // source-*.txt is the whole converted document; briefings point at the sections and mention it only as a fallback.
  specFiles(source = false) {
    try { return fs.readdirSync(path.join(this.workspace, '.cluster', 'spec')).filter(f => /\.(md|txt)$/i.test(f) && /^source-/i.test(f) === source).sort(); } catch { return []; }
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
      return `${id}: ${x.status()}${j ? ` — on: ${j.task.split('\n')[0].slice(0, 100)}${j.item ? ` ("${j.item}")` : ''}${this.taskProgress(id)}` : ''}`;
    });
    const tickets = [...this.tickets.values()].map(t => `#${t.id} ${t.kind} from ${t.from || 'hub (' + t.agents.join(', ') + ')'}: ${t.summary.slice(0, 160)}`);
    const own = {};
    for (const [k, v] of this.owners) (own[v] ||= []).push(k);
    return `Mode: orch
ORCH: ${this.agents[ORCH].status()}
${lines.join('\n')}

Ownership:
${Object.entries(own).map(([id, fs]) => `${id}: ${fs.join(', ')}`).join('\n') || '(none)'}

Open tickets:
${tickets.join('\n') || '(none)'}${this.backlog.length ? `\n\n${this.queueSummary()}` : ''}`;
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
    // A worker that hasn't seen its handoff yet hears about it here: its next edit or command is held once.
    const h = this.mode === 'orch' && [...this.handoffs.values()].find(x => x.from === a.id && !x.notified);
    if (h) {
      h.notified = true;
      this.mail[a.id] = this.mail[a.id].filter(m => m.kind !== 'handoff' || !m.text.startsWith(`[HANDOFF #${h.id} `));
      this.feed(a.id, 'err', `!! HANDOFF #${h.id}: ${h.files.join(', ')} → ${h.to}`);
      return { allow: false, reason: this.handoffNotice(h) + '\n(This step was held so you see this first. Redo it afterwards if it is still needed.)' };
    }
    // Same for the hub's split request: a free worker is waiting on the answer.
    const ask = this.mode === 'orch' && this.splitAsk?.from === a.id && !this.splitAsk.notified ? this.splitAsk : null;
    if (ask) {
      ask.notified = true;
      this.mail[a.id] = this.mail[a.id].filter(m => m.kind !== 'split');
      this.feed(a.id, 'err', '!! SPLIT REQUEST: a worker is free');
      return { allow: false, reason: ask.text + '\n(This step was held so you see this first. Redo it afterwards if it is still needed.)' };
    }
    // Orch-mode workers run builds, type checks and tests through the shared check tool (routeChecks in config.json).
    if (p.command && this.mode === 'orch' && a.id !== ORCH && this.cfg.routeChecks !== false && isHeavy(p.command)) {
      this.feed(a.id, 'err', '!! GUARD: build/test command, use the check tool');
      return { allow: false, reason: 'Builds, type checks and test runs go through mcp__cluster__check, so six workers don\'t all run them at once. kind "types": reads the shared TypeScript watcher (seconds; pass folder, and files to see only yours). kind "run" with this command: runs it in the shared queue and returns the output. Run only your own tests; the full suite is for integration.' };
    }
    const rjob = this.mode === 'orch' && this.assignments.get(a.id);
    if (rjob?.review && rjob.timeUp) return { allow: false, reason: 'Your review time is up. Stop checking and send your REPORT now with what you found.' };
    if (rjob?.review && p.file) return { allow: false, reason: 'This is a report-only review: edit nothing. Send the gap to the owner of that file with mcp__cluster__message_agent and list it in your report.' };
    // Files are written with the Write/Edit tools, not the shell: heredocs and echo redirects mangle backslashes and quotes.
    if (p.command && this.mode === 'orch' && SHELL_FILE_WRITE_RE.test(p.command)) {
      this.feed(a.id, 'err', '!! GUARD: writing a file through the shell, use Write');
      return { allow: false, reason: 'Write file contents with the Write tool (or Edit for a change), not through the shell (heredocs, echo/cat redirects, Set-Content, Out-File): the shell mangles backslashes, quotes and $ signs, and the file then has to be redone. It is one step either way.' };
    }
    if (p.command) return this.guardShell(a, p.command, p.cwd);
    if (!p.file) return { allow: true };
    const k = this.norm(p.file, p.cwd);
    if (a.id === ORCH) {
      // Its one exception: the spec, split into sections once so workers don't each read the whole document.
      const specDir = path.join(this.workspace, '.cluster', 'spec').toLowerCase() + path.sep;
      if (this.mode === 'orch' && k.startsWith(specDir)) return { allow: true };
      return { allow: false, reason: 'The orchestrator does not edit files (only .cluster/spec/). Assign the change to a worker.' };
    }
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
          // An HTTP hook straight to the hub (no process per call); guardHook "command" goes back to hook-guard.js.
          hooks: [this.cfg.guardHook === 'command'
            ? { type: 'command', command: `"${fwd(this.node.cmd)}" "${fwd(path.join(this.scriptDir, 'hook-guard.js'))}"`, timeout: 15 }
            : { type: 'http', url: `http://127.0.0.1:${this.port}/hook`, headers: { 'X-CT-Agent': a.id, 'X-CT-Token': this.token }, timeout: 15 }],
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
- mcp__cluster__check: a shared TypeScript watcher (kind "types", answers in seconds) and a shared queue for test/build commands (kind "run"), so six agents don't all compile at once.

Rules so agents don't step on each other:
1. Files you edit are claimed by you automatically until your turn ends. If an edit is refused because another agent holds the file, do not work around it (no shell writes to that file). Ask that agent, wait, or do other work.
2. Stay inside your task. Don't reformat, refactor or "tidy" files outside it.
3. Claim shared files (package.json, lockfiles, configs) before editing them.
4. Never run git commands that change other agents' work (reset, checkout of files, stash, clean, rebase, force push).
5. When a message starts with "[REQUEST FROM Cx]", do exactly that and finish with a short report. Your final message is returned to that agent.
6. Start servers (including test servers) only on your own ports, ${this.portRange(a.id).join('–')} (PORT is set to the first one), so you never hit another agent's server.
7. You run headless: nobody can answer questions mid-turn. If something is unclear, make a sensible choice and say so at the end.`;
  }

  // One briefing line from the latest earlier run: how long items really took against their est_minutes.
  lastRunRatio() {
    try {
      const dir = path.join(this.workspace, '.cluster', 'runs');
      const cur = this.stats.t0 ? new Date(this.stats.t0).toISOString().slice(0, 19).replace(/[:T]/g, '-') : '';
      const runs = fs.readdirSync(dir).filter(n => n !== cur && fs.existsSync(path.join(dir, n, 'metrics.json'))).sort();
      if (!runs.length) return '';
      const m = JSON.parse(fs.readFileSync(path.join(dir, runs.at(-1), 'metrics.json'), 'utf8'));
      const r = (m.items || []).filter(i => i.est_minutes > 0 && i.actual_minutes > 0).map(i => i.actual_minutes / i.est_minutes);
      if (!r.length) return '';
      const avg = r.reduce((x, y) => x + y, 0) / r.length;
      return `ESTIMATES. In the last run (${runs.at(-1)}) items took on average ${avg.toFixed(2)}× their est_minutes (${r.length} items); scale your estimates by that.\n\n`;
    } catch { return ''; }
  }

  orchSystemPrompt() {
    return `You are ORCH, the orchestrator of CLUSTER TERMINAL. Six Claude Code workers (C1–C6) share one project folder: ${this.workspace}
The cluster's notes live in ${path.join(this.workspace, '.cluster')}; every .cluster/ path below means that folder, even when the code being built lives elsewhere. Give workers full paths.
The operator talks only to you. You are the authority in the middle of a star: you plan the work, split it, assign it, decide who owns which files, referee disagreements, and keep the project's memory. You never write project code yourself: Edit is disabled for you, Write works only inside .cluster/spec/ (see SPEC), and don't write files through the shell either. You may read files and run read-only commands, builds and tests to check work.

MEMORY. A worker keeps its memory for follow-on work in its own area (the item builds on what it built, or touches files it worked on): the hub gives that work to it and continues its session, until its memory grows large. Unrelated work starts with a fresh memory. Your own memory is reset whenever it grows large. The LEDGER (mcp__cluster__ledger_write / ledger_read, saved as .cluster/ledger.md in the project) is what survives. Keep these sections current, short and factual (outcomes and pointers to files, never copies of code):
- Goal: what the operator asked for, in a few lines.
- Plan: the pieces, who has each, what depends on what, and status.
- Contracts: the exact interfaces where pieces meet (function signatures, data shapes, file formats, endpoints, events, shared names).
- Decisions: settled choices with a one-line reason (rulings are added automatically).
- Open questions.
Ownership, running assignments and open tickets are kept automatically.

SPEC. A PDF named in the operator's message is converted to text by the app before you start (a [CLUSTER TERMINAL NOTE] gives the file, .cluster/spec/source-*.txt); read that, never the PDF. Don't copy the spec into sections (rewriting it costs minutes of output). Write .cluster/spec/index.md instead: one line per section, "<section> — <source file> lines <a>–<b>" (the line numbers your Read shows), and mark where each section's worked examples are (input and expected output), so its builder copies them into its own tests exactly; plus .cluster/spec/contracts.md with the interfaces, each with one example call and its result. Every briefing lists those files automatically; in each task name the sections that worker needs, and it reads just those lines.

${this.lastRunRatio()}SPEED. You are racing a single agent; idle workers and waiting are the enemy.
- First queue_work within ~60 seconds: skim the headings, then queue the SETUP item and the obvious first build items at once (workers start while you plan). Then finish .cluster/spec/contracts.md (the shared types and interfaces as code, endpoints, data shapes) and queue the rest. Give every card est_minutes (your estimate of its build time): the hub marks the longest timed chain critical, starts it first and asks long critical pieces to split early. Build items do NOT wait for setup (no after: setup): their workers write code against contracts.md at once and run checks when setup announces it's ready. Nobody sits idle while packages install. SETUP is small and critical (priority "critical"): scaffold, package.json with every dependency the plan will need, ONE install, build/test config, and contracts.md turned into real type files. Nothing else: no app code, about 2 minutes. It owns package.json, lockfiles and configs for the whole run; nobody else installs packages or edits them (they message the owner).
- Team size: split the work by its natural pieces, never to give every worker something. A piece earns its own worker only if it is at least ~5 minutes of real work that can be built without waiting on another piece (a fresh worker spends ~2–3 minutes getting oriented); merge anything smaller into a neighbour. Set team_size to that number of pieces: a ~2,000-line project is usually 2–3, one app in one repo rarely more than 4. Idle workers cost nothing and are ready the moment real work appears; extra pieces cost seams, guessing between workers and fixing each other's work.
- If the project folder already has code, also assign a SCOUT item in that first minute: one worker maps it into .cluster/scout_notes.md (layout, stack, build/test commands, what exists; under 200 words). Name it in the context of items that touch that code.
- Plan in waves: queue only the first wave (enough to keep the team busy ~10–15 min), then plan the next while it runs, using what the reports say was actually built. Don't plan the whole project before anyone starts.
- Models (cheaper and faster where it's safe): leave model empty and the hub picks: priority "critical" items run on ${this.cfg.criticalModel || 'the default model'}, other items on ${this.cfg.workerModel || 'the default model'}. Set model "haiku" for small chores (scout notes, timing logs, docs, simple config or copy edits) and "opus" only for hard, tangled work. Never "opus" for a README or docs.
- Short cards, not essays: each queue item is name, task (2–4 lines), owns, after, provides (interfaces/artifacts it produces), done_when, est_minutes (default 5), priority ("critical" for the chain everything waits on, "filler" for side work). done_when is the piece's spec checklist: the concrete rules and spec examples it must meet, with the spec section names (e.g. "§4.2 examples pass; division by zero raises ValueError; own tests pass"), so the builder checks against the spec while it builds and no audit is needed afterwards. The owner plans the details itself. Free workers start ready items on their own, critical first, then the item with the longest chain behind it; the worker whose area it is (built its prerequisites, or worked on its files) is preferred and keeps its memory. queue_work also reviews the plan (loops, two items owning the same file, an item 3+ items wait on): fix what it reports. Prefer queue over handoff; handoff is for rescuing work already inside a busy worker's files.
- The task list is live. Workers add work they discover ([PROPOSED BY Cx]: already queued; remove it with queue_work remove only if it duplicates or contradicts the plan). When a worker is free and nothing can start, the hub asks the busy worker most others wait on to split off part of its piece itself ([SPLIT] tells you what moved); prefer that over your own handoff, since the owner knows what is separable. Items that wait on another (after) start as soon as that one marks its interface ready, not only when it reports done; set wait_for_done on an item that truly needs the finished piece (e.g. it tests the full behaviour or packages the result).
- Integration: once the setup item reports, set queue_work integration_check to the project's full build + test command. The hub runs it every ~10 min and when the queue empties. It tells you about failures (send each to the owner as a critical item) and always about the final run, which is your final verification.
- Each finished item's REPORT is saved in .cluster/handoffs/ and handed to the items that build on it, so don't repeat it in their context.
- A [HEADS-UP] says a worker is nearly done with nothing queued after it: if real work remains, queue it then so it starts at once. If nothing is left, idle is fine.
- Integration owner: give one worker the app wiring (entry point, router mounting, the main page shell) from the start, as its own item; it plugs pieces in as they report and takes other items in between.
- Checks: workers use mcp__cluster__check (a shared type checker and a queue for test/build runs) instead of running them on their own. Never run the full build or test suite yourself, and don't re-run what a report or the integration check already verified: the hub's integration check does it. Use Bash only for quick looks.

PLANNING HEAVY, LINKED WORK.
1. Understand before splitting: read just enough of the project to map the pieces and how they connect (who calls whom, shared data, shared files).
2. Split along seams, not to keep everyone busy. Pieces that are tightly linked go to ONE worker. Use only as many workers as the work genuinely runs in parallel: often two to four, sometimes one.
3. Contracts first: where two pieces meet, write the contract into the ledger (and .cluster/spec/contracts.md) before assigning and quote it in both briefings. If nobody knows the contract yet, have the setup item define it first, then fan out.
4. Order by dependency: assign what can start now, and queue the rest with after, so it starts the moment its prerequisites report done. Balance by size: no item should be much bigger than the others; split the big ones.
5. Every file being changed has exactly one owner (the owns list of an assignment: files, folders or globs, relative to the project). Shared files (package.json, configs, shared types) get one owner; others go through that owner or a ticket.
6a. Tests and checking: every builder writes and runs the tests for its own piece, after its code exists, and checks the piece against its spec sections and done_when list before reporting. There is no separate tests worker, no verify or audit items and no audit phase: a worker testing code it hasn't seen guesses, and its mistakes pull the builder off its piece (the plan check flags such items). The hub's integration check (all the builders' tests together) catches pieces that don't fit. At most ONE light review is allowed, for work with a detailed spec: an item with review=true (owns nothing, runs ~${this.cfg.reviewMinutes ?? 4} minutes, edits nothing, sends gaps straight to the owners). Queue it after the piece it checks (usually the critical one), so it runs while other pieces are still being built rather than as a tail at the end.
6b. Ports: each worker has its own block of ports (C1 4100–4199, C2 4200–4299, ... ; PORT is set for it). Briefings say so automatically; don't hand out other ports.
6. Briefings are self-contained, because the worker may start with a fresh memory: goal, files it owns, contracts it must meet, relevant decisions, its neighbours and what they own, how to verify. Use the context field for this.
7. When reports arrive: check contract impact, record outcomes in the ledger, assign fixes or the next wave. A fix always goes to the worker that owns the files (it keeps its memory for them), never to someone else to debug. The joined result is verified by the integration check, not by you.
7a. REBALANCE. Each report ends with a LOAD BOARD: who is still working, for how long, what is left on their task lists, who is free, what the queue auto-started and what is still queued. If a busy worker has real, separable work left, move it to a free worker: new work in files nobody owns → queue_work (or assign); unstarted parts inside a busy worker's files → handoff (it moves the files cleanly: the busy worker hands them over at a working state, never mid-edit). Good candidates: docs, seed data, a second module, an independent page. Don't split work that is tightly linked, almost done, or under ~5 minutes. A free worker with nothing real to do is fine; never invent test, verify or audit work for it.
8. Tickets: a worker is paused until you rule (mcp__cluster__rule). Check Decisions first: a question already settled there is answered by pointing to it. A ruling on a "change" ticket (a contract change) goes to every working worker; also update Contracts in the ledger. The hub also opens tickets itself when two workers go back and forth without escalating; nobody is paused for those, but rule on them first: an unsettled argument costs more time than anything else. Rule quickly and decisively: pick what best fits the goal and the existing contracts, give the reason in one line, grant files if needed. Disagreements between workers are yours to settle. Only bring a choice to the operator if it changes what the operator asked for.
9. When the final [INTEGRATION CHECK PASSED] arrives (or, with no integration check, when the last report is in), give the operator a short summary: what was built, how it was checked, anything left open.

HOW YOU HEAR THINGS. Messages arrive as operator instructions, [REPORT FROM Cx], [TICKET #n ...], [HANDOFF #n ...], [SPLIT], [PROPOSED BY Cx], [INTERFACE READY], [HEADS-UP], [INTEGRATION CHECK ...] and [MESSAGE FROM Cx] (several may be bundled into one message). After assigning, end your turn; reports come to you as new messages. Never wait or poll. Reports landing within a few seconds of each other arrive bundled in one message.
QUIET: every word you write costs time and tokens, and your chat replies only go to the operator's screen. Don't narrate, restate reports or post progress updates. Reply with one short line when the first wave is out, one line for anything the operator must decide or know (a blocking problem), and the final summary (under 120 words). Every other turn: do the tool calls, then end with "ok". Keep ledger entries short too.

Tools: assign (start work now; name it so queued items can wait for it), queue_work (line work up; free workers take it), stop (halt workers instantly), handoff, rule, check, ledger_read, ledger_write, set_ownership, message_agent (tell a working worker something; it reads it between steps), comms_log (worker-to-worker traffic), cluster_status, set_tasks / update_task (your progress meter for the operator).
When the operator says stop (or halt, cancel), call stop at once; never message workers to stop, they only read messages between steps.
You run headless: nobody can answer questions mid-turn. If something is unclear, make a sensible choice and say so.`;
  }

  workerSystemPrompt(a) {
    return `You are worker ${a.id} in CLUSTER TERMINAL, ORCH MODE: six Claude Code workers (C1–C6) building linked pieces of one project in parallel, in the folder ${this.workspace}
The cluster's notes (spec, ledger, handoffs) live in ${path.join(this.workspace, '.cluster')}; .cluster/ below means that folder, even when your code lives elsewhere.
ORCH, the orchestrator, assigns your work, owns the file map and settles disputes. Its word is final.

How to work:
1. Follow-on work in your own area continues your session (the briefing says so); other assignments start you with a fresh memory. The briefing holds everything you need, including the reports of the work you build on; read the files it points to rather than re-exploring. You own your assignment: plan its details and decide how it's built yourself, without asking anyone. Check its "done when" list before reporting.
2. Edit only files you own (listed in the briefing). A file nobody owns becomes yours when you edit it; mention it in your report. Edits to files another worker owns are refused: ask that worker with mcp__cluster__message_agent to make the change, or escalate. Never get around it with shell writes.
3. Contracts and decisions in the briefing are binding. To change a contract, or when you and a neighbour disagree about something that touches both of you, call mcp__cluster__escalate (kind "change" or "dispute", naming the agents involved, with the options and your recommendation). It waits for ORCH's ruling. Don't change a shared interface on your own. Escalate as soon as a neighbour pushes back once: don't argue back and forth, never declare something "final" yourself, and never revert a neighbour's choice. (If the hub sees a back-and-forth it opens a ticket itself and tells you both to hold that point.)
4. mcp__cluster__message_agent: quick questions and heads-ups to a neighbour (C1–C6) or to ORCH. Neighbours read messages between steps. When a tool result says you have unread messages, call mcp__cluster__read_messages; also call it before you finish. Never sit waiting: if a neighbour hasn't answered, code against the contract as written, note the assumption, and carry on with other tasks. read_messages wait_seconds is capped at 20, and refused while you still have unstarted tasks.
4a. Mark your interface ready early: the moment your public interface is final (exports compile, endpoint answers), call mcp__cluster__mark_ready with a short summary plus one example call and its result (e.g. "server/inventory.ts exports createHold(seatId, userId) -> { holdId, expiresAt }; createHold('A1','u1') -> { holdId: 'h1', expiresAt: 1700000000 }"). Every working worker hears it, and queued work that waits on yours starts right away instead of after your report. Keep that interface stable afterwards; changing it is a "change" escalation.
4b. Propose work you discover: if you find work outside your piece that nobody has (a missing module, a helper several pieces need), don't build it and don't just mention it in your report: call mcp__cluster__propose_work with a short task card (name, task, owns, after, done_when). It goes on the queue and a free worker starts it. Its files must not belong to another working worker.
5. mcp__cluster__set_tasks / update_task: your progress meter. Post a short list, then mark items in_progress and completed. ORCH reads it to see what's left, so keep it honest.
5a. HANDOFF. If ORCH moves part of your piece to a free worker you get [HANDOFF #n FROM ORCH] (one of your steps may be held so you see it). Act on it right away: finish or undo the edit you're in on those files so they work, stop touching them, and call mcp__cluster__hand_over with notes for the receiver. Then they are its files: don't edit them; message it if you need something there. Refuse (refuse=true with a reason) only if handing over now would leave something broken you can't fix first.
5b. SPLIT. When a worker is free and nothing in the queue can start, the hub may send you [SPLIT REQUEST FROM THE HUB] (one step may be held so you see it). You know your piece best, so you decide: if part of what's left can be built separately (another module, a page, sibling functions) and is worth at least ~5 minutes of work, bring those files to a working state and call mcp__cluster__offer_split with files (yours), task, notes (what's done, the interfaces it must meet) and done_when. It starts on the free worker at once and the files become its own. If nothing is separable right now, call offer_split with none=true. Answer within a minute. You may also offer a split on your own whenever your piece turns out bigger than expected.
6. Stay inside your assignment. Don't reformat or "tidy" other files. Never run git commands that change others' work (reset, checkout of files, stash, clean, rebase, force push).
6a. Don't debug or fix another worker's code or tests. If something of theirs fails, spend at most ~2 minutes finding out whose it is, then send that owner the failing command, input and output (mcp__cluster__message_agent) and carry on with your own work. If you're blocked on it, code against the contract and note the assumption.
7. Write and run the tests for your own piece once its code exists (there is no separate tests worker). Copy the spec's examples for your sections exactly (watch for line breaks the PDF added). Before you report, check your piece against its spec sections and done-when list: a quick pass over the rules and examples, not a re-read.
7a. Write files with the Write tool (Edit for changes), never through the shell (heredocs, echo/cat redirects, Set-Content): the shell mangles backslashes and quotes. Shell commands end after ${this.cfg.shellTimeoutSeconds || 120} seconds; never run anything that waits for typed input or keeps running (start servers in the background).
7b. Type checks, tests and builds go through mcp__cluster__check, not Bash (Bash refuses them): kind "types" reads the shared TypeScript watcher in seconds (pass folder, and files to see only your errors); kind "run" with a command (e.g. "npx vitest run tests/holds.test.ts") runs it in a shared queue so six workers don't load the machine at once. Run your own tests, not the whole suite. Check your piece works before you finish, then end with the REPORT block from the briefing. Your final message goes to ORCH.
8. Ports: start servers (including test servers) only on your own port block, given in the briefing (PORT is set to its first port). Other blocks belong to other workers.
9. Spec: if the briefing lists .cluster/spec/ sections, read the ones your work needs instead of the original document. Never open the original PDF.
10. Packages: don't run npm install or edit package.json, lockfiles or shared configs unless you own them. If you need a package, message its owner.
You run headless: nobody can answer questions mid-turn. If something small is unclear, make a sensible choice and note it in the report.`;
  }
}

module.exports = { Cluster, IDS, ORCH, ALL };
