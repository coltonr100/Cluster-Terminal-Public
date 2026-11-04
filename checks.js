'use strict';
// Shared checks behind the agents' `check` tool: one TypeScript watcher per project folder that
// every agent reads (instead of six agents each running tsc), and a small queue for heavy commands
// (tests, builds) so they don't all run at once on one machine.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// A command that type-checks, tests or builds: heavy enough that workers should run it through `check`.
// Only counts when the tool is the command being run (start of a command, after npx / .bin/), not a mention.
const HEAVY_RE = /(?:^|[;&|(\n]\s*|\bnpx\s+|\bpnpm\s+(?:exec\s+)?|\byarn\s+|\.bin\/)(?:tsc|vitest|jest|mocha|pytest)\b|\bnpm\s+(?:run\s+)?(?:test|build|typecheck)\b|\bvite\s+build\b/i;
const isHeavy = cmd => HEAVY_RE.test(cmd) && !/--(?:version|help|init)\b/.test(cmd);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tail = (s, n) => {
  const lines = String(s).trim().split(/\r?\n/);
  return (lines.length > n ? `… (${lines.length - n} earlier lines)\n` : '') + lines.slice(-n).join('\n');
};

class Checks {
  constructor({ node, gitBash, slots, timeoutMs, killTree }) {
    this.node = node;
    this.gitBash = gitBash;
    this.slots = Math.max(1, slots || 2);
    this.timeoutMs = timeoutMs || 10 * 60000;
    this.killTree = killTree;
    this.watchers = new Map();   // folder -> tsc watcher
    this.waiting = [];           // heavy commands waiting for a free slot
    this.running = 0;
    this.procs = new Set();
  }

  // ---- TypeScript: one `tsc --watch` per folder, started on first use ----
  watcher(dir) {
    let w = this.watchers.get(dir);
    if (w && w.proc.exitCode === null) return w;
    const tsc = path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!fs.existsSync(tsc) || !fs.existsSync(path.join(dir, 'tsconfig.json'))) return null;
    const proc = spawn(this.node.cmd, [tsc, '--noEmit', '--watch', '--preserveWatchOutput', '--pretty', 'false'],
      { cwd: dir, env: { ...process.env, ...this.node.env }, windowsHide: true });
    w = { proc, buf: '', lines: [], last: null, compiling: true, waiters: [], output: '', exited: false };
    const onLine = raw => {
      const line = raw.replace(/^\[?\d{1,2}:\d{2}:\d{2}\s*(?:[AP]M)?\]?\s*-\s*/i, '').trimEnd();
      if (/^(Starting compilation|File change detected|Starting incremental compilation)/i.test(line)) { w.compiling = true; w.lines = []; return; }
      const m = line.match(/^Found (\d+) errors?\b/);
      if (m) {
        w.compiling = false;
        w.last = { count: +m[1], lines: w.lines, t: Date.now() };
        w.lines = [];
        for (const f of w.waiters.splice(0)) f();
      } else if (line.trim()) w.lines.push(line);
    };
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => {
      w.output = (w.output + d).slice(-4000);
      w.buf += d;
      let i;
      while ((i = w.buf.indexOf('\n')) >= 0) { onLine(w.buf.slice(0, i)); w.buf = w.buf.slice(i + 1); }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', d => { w.output = (w.output + d).slice(-4000); });
    // If tsc can't run (or dies), whoever is waiting hears about it at once.
    const end = () => { w.exited = true; w.compiling = false; for (const f of w.waiters.splice(0)) f(); };
    proc.on('error', e => { w.output += '\n' + e.message; end(); });
    proc.on('exit', end);
    this.watchers.set(dir, w);
    return w;
  }

  // Latest type errors for a folder, after the watcher has caught up with recent edits.
  // only: file paths (relative to the folder) to show errors for; the total is always given.
  async types(dir, only = []) {
    const w = this.watcher(dir);
    if (!w) return null;
    await sleep(1500);   // time for the watcher to notice the most recent edits
    if (!w.exited && (w.compiling || !w.last)) {
      await new Promise(res => {
        const t = setTimeout(res, 180000);
        w.waiters.push(() => { clearTimeout(t); res(); });
      });
    }
    if (w.exited) {
      this.watchers.delete(dir);
      return { text: `The shared type checker stopped (tsc --watch exited), so use kind "run" with your type-check command instead. Its last output:\n${tail(w.output, 15)}` };
    }
    if (!w.last) return { text: 'The shared type checker is still compiling after 3 minutes. Try again shortly.' };
    // Group the output into one block per error (the first line names the file, the rest is detail).
    const blocks = [];
    for (const l of w.last.lines) {
      if (/^\S.*\(\d+,\d+\): error /.test(l) || /^error /.test(l) || !blocks.length) blocks.push([l]);
      else blocks.at(-1).push(l);
    }
    const want = only.map(f => f.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()).filter(Boolean);
    const shown = want.length ? blocks.filter(b => want.some(f => b[0].replace(/\\/g, '/').toLowerCase().startsWith(f))) : blocks;
    const head = `Type check (shared watcher, ${path.basename(dir)}): ${w.last.count} error(s) in the whole project${want.length ? `, ${shown.length} in the files you asked about` : ''}.`;
    if (!shown.length) return { text: head };
    const body = shown.slice(0, 40).map(b => b.join('\n')).join('\n');
    return { text: `${head}\n${body}${shown.length > 40 ? `\n… (${shown.length - 40} more)` : ''}` };
  }

  // ---- heavy commands: at most `slots` at a time, the rest wait their turn ----
  slot() {
    if (this.running < this.slots) { this.running++; return Promise.resolve(); }
    return new Promise(r => this.waiting.push(r));
  }

  release() {
    const next = this.waiting.shift();
    if (next) next(); else this.running--;
  }

  async run(cmd, cwd, env) {
    const queued = Date.now();
    await this.slot();
    const started = Date.now();
    try {
      return await new Promise(res => {
        // Git Bash when there is one, so commands use the same syntax as the agents' Bash tool.
        const p = this.gitBash
          ? spawn(this.gitBash, ['-c', cmd], { cwd, env, windowsHide: true })
          : spawn(cmd, { cwd, env, shell: true, windowsHide: true });
        this.procs.add(p);
        let out = '', timedOut = false;
        const add = d => { out = (out + d).slice(-200000); };
        p.stdout.setEncoding('utf8'); p.stdout.on('data', add);
        p.stderr.setEncoding('utf8'); p.stderr.on('data', add);
        const timer = setTimeout(() => { timedOut = true; this.killTree(p); }, this.timeoutMs);
        p.on('error', e => { out += '\n' + e.message; });
        p.on('close', code => {
          clearTimeout(timer);
          this.procs.delete(p);
          const secs = Math.round((Date.now() - started) / 1000), waited = Math.round((started - queued) / 1000);
          const head = `${timedOut ? `Stopped after ${Math.round(this.timeoutMs / 60000)} min (timeout)` : `Exit code ${code}`} · ${secs}s${waited >= 2 ? ` (waited ${waited}s for a free check slot)` : ''}`;
          res({ text: `${head}\n${tail(out, 80)}` });
        });
      });
    } finally {
      this.release();
    }
  }

  stopAll() {
    for (const w of this.watchers.values()) this.killTree(w.proc);
    this.watchers.clear();
    for (const p of this.procs) this.killTree(p);
    this.procs.clear();
  }
}

module.exports = { Checks, isHeavy };
