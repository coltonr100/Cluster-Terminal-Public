'use strict';
// Offline test of orch mode: the hub's orchestrator logic with fake Claude Code processes
// (no usage, no window). Run: node test-orch.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { Cluster, IDS, ORCH } = require('./orchestrator');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-orch-test-'));
const dataDir = path.join(tmp, 'data');
const ws = path.join(tmp, 'ws');
fs.mkdirSync(dataDir); fs.mkdirSync(ws);
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ workspace: ws }));

const c = new Cluster(__dirname, dataDir);
// Fake processes: record what each agent is sent; tests finish turns by hand.
const sent = Object.fromEntries([...IDS, ORCH].map(id => [id, []]));
for (const a of Object.values(c.agents)) {
  a.ensureProc = function () {
    if (this.proc) return;
    if (!this.sessionId) this.sessionId = require('crypto').randomUUID();
    this.resumable = true;
    this.proc = { exitCode: null, pid: 0, stdin: { write: s => sent[this.id].push(JSON.parse(s).message?.content) } };
  };
}
const finish = (id, text) => c.agents[id].handle({ type: 'result', result: text });
const tick = () => new Promise(r => setImmediate(r));
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('PASS ', name); };

(async () => {
  c.port = 1; c.token = 't';
  c.setMode('orch');
  assert.equal(c.mode, 'orch');

  await test('operator text goes to ORCH, with a ledger briefing on a fresh session', async () => {
    c.userSend('C3', 'Build a todo app');
    assert.equal(sent.C3.length, 0);
    assert.equal(sent.ORCH.length, 1);
    assert.match(sent.ORCH[0], /ORCHESTRATOR BRIEFING/);
    assert.match(sent.ORCH[0], /Build a todo app/);
  });

  await test('ledger_write saves sections and the ledger file', async () => {
    await c.rpc(ORCH, 'ledger_write', { section: 'Goal', text: 'Todo app with API and UI' });
    await c.rpc(ORCH, 'ledger_write', { section: 'Contracts', text: 'GET /api/todos -> [{id,text,done}]' });
    const md = fs.readFileSync(path.join(ws, '.cluster', 'ledger.md'), 'utf8');
    assert.match(md, /## Goal\nTodo app/);
    assert.match(md, /GET \/api\/todos/);
    await assert.rejects(c.rpc(ORCH, 'ledger_write', { section: 'Ownership', text: 'x' }));
  });

  await test('workers cannot use orchestrator tools, and ORCH cannot use worker tools', async () => {
    await assert.rejects(c.rpc('C1', 'assign', { tasks: [] }), /orchestrator/);
    await assert.rejects(c.rpc(ORCH, 'escalate', { kind: 'question', summary: 'x' }), /workers/);
    await assert.rejects(c.rpc('C1', 'ask_agent', { agent: 'C2', request: 'x' }), /message_agent/);
  });

  await test('assign: fresh briefed sessions, ownership, overlap refused', async () => {
    const r = await c.rpc(ORCH, 'assign', { tasks: [
      { agent: 'C1', task: 'Build the API in server/', owns: ['server'], context: 'Contract: GET /api/todos' },
      { agent: 'C2', task: 'Build the UI', owns: ['web/*.js', 'web/index.html'] },
      { agent: 'C3', task: 'Also touch the API', owns: ['server/db.js'] },
    ] });
    assert.match(r.text, /Assigned: C1, C2/);
    assert.match(r.text, /C3: server\/db\.js overlaps C1/);
    assert.match(sent.C1[0], /\[ASSIGNMENT FROM ORCH\]/);
    assert.match(sent.C1[0], /Contract: GET \/api\/todos/);
    assert.match(sent.C1[0], /Todo app with API and UI/);      // ledger goal is in the briefing
    assert.match(sent.C1[0], /C2: Build the UI/);              // neighbours are listed
    assert.equal(c.ownerOf(c.norm('server/routes/x.js')), 'C1');
    assert.equal(c.ownerOf(c.norm('web/app.js')), 'C2');
    assert.equal(c.ownerOf(c.norm('web/lib/deep.js')), null);  // * stays in one folder
    assert.ok(c.linkRefs.get('C1-ORCH') > 0);
    assert.equal(c.agents.C1.snapshot().role, 'worker');
    assert.equal(c.agents[ORCH].snapshot().role, 'orch');
  });

  await test('guard: owner may edit, others refused (edit and shell), unowned file is taken', async () => {
    c.agents.C1.busy = true; c.agents.C2.busy = true;
    assert.equal(c.guard(c.agents.C1, { file: 'server/app.js', cwd: ws }).allow, true);
    const no = c.guard(c.agents.C2, { file: 'server/app.js', cwd: ws });
    assert.equal(no.allow, false);
    assert.match(no.reason, /owned by C1/);
    assert.equal(c.guard(c.agents.C2, { file: 'README.md', cwd: ws }).allow, true);
    assert.equal(c.ownerOf(c.norm('README.md')), 'C2');
    assert.deepEqual(c.assignments.get('C2').took, ['README.md']);
    assert.equal(c.guard(c.agents.C1, { command: 'echo hi > README.md', cwd: ws }).allow, false);
    assert.equal(c.guard(c.agents[ORCH], { file: 'x.js', cwd: ws }).allow, false);
  });

  await test('message_agent delivers to a mailbox; read_messages waits for one', async () => {
    const r = await c.rpc('C2', 'message_agent', { agent: 'C1', message: 'Is done a boolean?' });
    assert.match(r.text, /Delivered to C1/);
    const st = await c.rpc('C1', 'set_tasks', { tasks: ['a'] });
    assert.match(st.text, /1 unread message/);
    const box = await c.rpc('C1', 'read_messages', {});
    assert.match(box.text, /From C2 \(message\): Is done a boolean\?/);
    const waiting = c.rpc('C2', 'read_messages', { wait_seconds: 5 });
    setTimeout(() => c.rpc('C1', 'message_agent', { agent: 'C2', message: 'Yes, boolean.' }), 50);
    assert.match((await waiting).text, /Yes, boolean/);
  });

  await test('escalate pauses the worker until ORCH rules; ruling goes to the ledger and the other side', async () => {
    finish(ORCH, 'Assigned the API and UI.');      // ORCH's first turn ends
    await tick();
    const before = sent.ORCH.length;
    const p = c.rpc('C2', 'escalate', { kind: 'dispute', summary: 'C1 wants ids as numbers, I want strings. Recommend strings.', agents: ['C1'] });
    await tick();
    assert.equal(c.agents.C2.status(), 'AWAITING ORCH');
    assert.equal(sent.ORCH.length, before + 1);
    assert.match(sent.ORCH.at(-1), /\[TICKET #1 · DISPUTE FROM C2 · involves C1\]/);
    const r = await c.rpc(ORCH, 'rule', { ticket: 1, decision: 'Strings: they survive JSON and URLs unchanged.' });
    assert.match(r.text, /C1 notified/);
    assert.match((await p).text, /ORCH RULING on #1: Strings/);
    assert.match(c.ledger.Decisions, /#1 \(C2 dispute with C1\): Strings/);
    assert.match((await c.rpc('C1', 'read_messages', {})).text, /Ruling on ticket #1/);
    await assert.rejects(c.rpc(ORCH, 'rule', { ticket: 1, decision: 'again' }), /No open ticket/);
  });

  await test('reports go to ORCH; reports landing while it is busy are bundled into one message', async () => {
    finish(ORCH, 'Ruled.');
    await tick();
    c.agents[ORCH].busy = false;
    c.agents[ORCH].pump();
    const before = sent.ORCH.length;
    c.userSend(ORCH, 'How is it going?');   // ORCH is busy with this turn
    await tick();
    finish('C1', 'REPORT\nDone: API built');
    finish('C2', 'REPORT\nDone: UI built');
    await tick();
    assert.equal(c.agents[ORCH].queue.length, 1, 'two reports, one queued message');
    assert.match(c.agents[ORCH].queue[0].text, /REPORT FROM C1[\s\S]*REPORT FROM C2/);
    assert.match(c.agents[ORCH].queue[0].text, /No assignments are running now/);
    assert.equal(c.assignments.size, 0);
    assert.equal(c.ownerOf(c.norm('server/app.js')), 'C1', 'ownership outlasts the assignment');
    finish(ORCH, 'Going well.');
    await tick();
    assert.equal(sent.ORCH.length, before + 2);
    finish(ORCH, 'All done: API and UI built and tested.');
    await tick();
    assert.ok(!c.agents[ORCH].busy, 'ORCH is idle after its wrap-up');
  });

  await test('idle worker can be re-assigned; follow-up with fresh:false keeps the session', async () => {
    const sid = c.agents.C1.sessionId;
    await c.rpc(ORCH, 'assign', { tasks: [{ agent: 'C1', task: 'Fix a bug', owns: ['server'], fresh: false }] });
    assert.equal(c.agents.C1.sessionId, sid);
    finish('C1', 'REPORT\nDone: fixed');
    await tick();
    await c.rpc(ORCH, 'assign', { tasks: [{ agent: 'C1', task: 'New piece', owns: ['server'] }] });
    assert.notEqual(c.agents.C1.sessionId, sid);
    finish('C1', 'REPORT\nDone');
    await tick();
  });

  await test('watchdog gives a large ORCH a fresh memory and the next message is briefed', async () => {
    while (c.agents[ORCH].busy || c.agents[ORCH].queue.length) { finish(ORCH, 'ok'); await tick(); }
    const o = c.agents[ORCH];
    o.ctx = 999999;
    const sid = o.sessionId;
    c.watch();
    assert.notEqual(o.sessionId, sid);
    assert.equal(o.ctx, 0);
    c.userSend(ORCH, 'Next job');
    assert.match(sent.ORCH.at(-1), /ORCHESTRATOR BRIEFING[\s\S]*Strings[\s\S]*Next job/);
    finish(ORCH, 'ok');
    await tick();
  });

  await test('HALT in orch mode drops open tickets and assignments', async () => {
    await c.rpc(ORCH, 'assign', { tasks: [{ agent: 'C4', task: 'x', owns: ['x'] }] });
    c.agents.C4.busy = true;
    const p = c.rpc('C4', 'escalate', { kind: 'question', summary: 'which?' });
    c.stop(ORCH);
    assert.match((await p).text, /halted/);
    assert.equal(c.assignments.size, 0);
  });

  await test('state survives a restart (ownership and ledger)', async () => {
    c.saveNow();
    const c2 = new Cluster(__dirname, dataDir);
    assert.equal(c2.mode, 'orch');
    assert.equal(c2.ownerOf(c2.norm('server/x.js')), 'C1');
    assert.match(c2.ledger.Goal, /Todo app/);
  });

  await test('individual mode: ORCH is out of the way', async () => {
    c.setMode('individual');
    assert.equal(c.activeAgents().length, 6);
    c.userSend('C2', 'hello');
    assert.equal(sent.C2.at(-1), 'hello');
    await assert.rejects(c.rpc('C2', 'message_agent', { agent: 'C1', message: 'x' }), /ask_agent/);
  });

  await test('mcp-bridge gives each role its own tools', async () => {
    const list = (agent, mode) => {
      const out = execFileSync(process.execPath, [path.join(__dirname, 'mcp-bridge.js')], {
        input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n',
        env: { ...process.env, CT_AGENT: agent, CT_MODE: mode, CT_PORT: '1' }, timeout: 3000,
      }).toString();
      return JSON.parse(out.split('\n')[0]).result.tools.map(t => t.name);
    };
    const orchTools = list('ORCH', 'orch'), worker = list('C2', 'orch'), solo = list('C2', 'individual');
    assert.ok(orchTools.includes('assign') && orchTools.includes('rule') && !orchTools.includes('escalate'));
    assert.ok(worker.includes('escalate') && worker.includes('read_messages') && !worker.includes('assign') && !worker.includes('ask_agent'));
    assert.ok(solo.includes('ask_agent') && !solo.includes('escalate') && !solo.includes('dispatch'));
  });

  console.log(`\n${n} tests passed`);
  c.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
