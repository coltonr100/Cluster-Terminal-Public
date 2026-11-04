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
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ workspace: ws, orchBatchSeconds: 0 }));

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
    assert.match(c.agents[ORCH].queue[0].text, /LOAD BOARD: no assignments are running/);
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
    // Work in files it worked on keeps its memory by default; unrelated work starts fresh.
    await c.rpc(ORCH, 'assign', { tasks: [{ agent: 'C1', task: 'More in its own files', owns: ['server'] }] });
    assert.equal(c.agents.C1.sessionId, sid);
    assert.match(sent.C1.at(-1), /continues your previous session/);
    finish('C1', 'REPORT\nDone');
    await tick();
    await c.rpc(ORCH, 'assign', { tasks: [{ agent: 'C1', task: 'New piece', owns: ['docs-unrelated'] }] });
    assert.notEqual(c.agents.C1.sessionId, sid);
    const sid2 = c.agents.C1.sessionId;
    finish('C1', 'REPORT\nDone');
    await tick();
    // fresh=true always wipes, even in its own files.
    await c.rpc(ORCH, 'assign', { tasks: [{ agent: 'C1', task: 'Again', owns: ['server'], fresh: true }] });
    assert.notEqual(c.agents.C1.sessionId, sid2);
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

  const drain = async () => { while (c.agents[ORCH].busy || c.agents[ORCH].queue.length) { finish(ORCH, 'ok'); await tick(); } };

  await test('reports carry a load board that asks ORCH to rebalance onto free workers', async () => {
    await drain();
    await c.rpc(ORCH, 'assign', { tasks: [
      { agent: 'C3', task: 'Money module', owns: ['money'] },
      { agent: 'C5', task: 'Small page', owns: ['pages/a.html'] },
    ] });
    await c.rpc('C3', 'set_tasks', { tasks: ['payments', 'refunds', 'payouts'] });
    await c.rpc('C3', 'update_task', { index: 1, status: 'completed' });
    finish('C5', 'REPORT\nDone: page');
    await tick();
    const note = sent.ORCH.at(-1);
    assert.match(note, /REPORT FROM C5/);
    assert.match(note, /LOAD BOARD\nStill working:\n- C3: \d+ min on "Money module" · tasks 1\/3 · left: refunds; payouts/);
    assert.match(note, /Free: .*C5 \(free 0 min\)/);
    assert.match(note, /REBALANCE/);
    finish(ORCH, 'ok'); await tick();
  });

  await test('assign into a busy worker\'s files is refused with a pointer to handoff', async () => {
    const r = await c.rpc(ORCH, 'assign', { tasks: [{ agent: 'C5', task: 'Payouts', owns: ['money/payouts.js'] }] });
    assert.match(r.text, /C5: money\/payouts\.js overlaps C3's files while C3 is working \(to move part of C3's work to C5, use handoff\)/);
  });

  await test('handoff checks: giver must be working and own the files; receiver must be free', async () => {
    await assert.rejects(c.rpc(ORCH, 'handoff', { from: 'C5', to: 'C6', files: ['pages/a.html'], task: 'x' }), /no running assignment/);
    await assert.rejects(c.rpc(ORCH, 'handoff', { from: 'C3', to: 'C6', files: ['server/x.js'], task: 'x' }), /not owned by C3 \(owner: C1\)/);
    await assert.rejects(c.rpc(ORCH, 'handoff', { from: 'C3', to: 'C3', files: ['money/x.js'], task: 'x' }), /different/);
    await assert.rejects(c.rpc(ORCH, 'handoff', { from: 'C3', to: 'C6', files: ['money/x.js'] }), /task is required/);
    await assert.rejects(c.rpc('C3', 'handoff', { from: 'C3', to: 'C6', files: ['money/x.js'], task: 'x' }), /orchestrator/);
  });

  await test('handoff: receiver reserved, giver told once, files and edit locks move only on hand_over', async () => {
    const g = c.agents.C3;
    g.busy = true;
    // C3 is mid-way through payouts.js: it owns it and holds the edit lock.
    assert.equal(c.guard(g, { file: 'money/payouts.js', cwd: ws }).allow, true);
    assert.equal(c.claims.get(c.norm('money/payouts.js')), 'C3');
    const r = await c.rpc(ORCH, 'handoff', { from: 'C3', to: 'C5', files: ['money/payouts.js', 'money/payouts.test.js'], task: 'Finish payouts and its tests', context: 'Payout contract: pay(eventId)' });
    assert.match(r.text, /Handoff #1 proposed/);
    // C5 is promised: no other assignment or handoff can take it meanwhile.
    assert.match((await c.rpc(ORCH, 'assign', { tasks: [{ agent: 'C5', task: 'other', owns: ['zzz'] }] })).text, /C5: busy with "handoff #1"/);
    await assert.rejects(c.rpc(ORCH, 'handoff', { from: 'C3', to: 'C6', files: ['money/refunds.js'], task: 'x' }), /already has handoff #1/);
    // C3's next step is held once with the notice; after that it may finish its edit.
    const held = c.guard(g, { command: 'ls money', cwd: ws });
    assert.equal(held.allow, false);
    assert.match(held.reason, /\[HANDOFF #1 FROM ORCH\][\s\S]*money\/payouts\.js[\s\S]*hand_over with handoff 1/);
    assert.equal(c.guard(g, { command: 'ls money', cwd: ws }).allow, true);
    assert.equal(c.guard(g, { file: 'money/payouts.js', cwd: ws }).allow, true, 'giver can still bring it to a working state');
    assert.equal(c.ownerOf(c.norm('money/payouts.js')), 'C3');
    const before = sent.C5.length;
    const ho = await c.rpc('C3', 'hand_over', { handoff: 1, notes: 'pay() is half-written; tests not started' });
    assert.match(ho.text, /now belong to C5; don't edit them/);
    // Ownership and the edit lock moved; the rest of money/ stays with C3.
    assert.equal(c.ownerOf(c.norm('money/payouts.js')), 'C5');
    assert.equal(c.ownerOf(c.norm('money/refunds.js')), 'C3');
    assert.equal(c.claims.get(c.norm('money/payouts.js')), undefined);
    // C5 started fresh with the task, the giver's notes, the context and its own ports.
    assert.equal(sent.C5.length, before + 1);
    assert.match(sent.C5.at(-1), /Finish payouts and its tests[\s\S]*handed to you by C3 \(handoff #1\)[\s\S]*pay\(\) is half-written[\s\S]*Payout contract[\s\S]*4500–4599/);
    c.agents.C5.busy = true;
    // Now the giver is refused and the receiver allowed, by edit and by shell.
    assert.equal(c.guard(g, { file: 'money/payouts.js', cwd: ws }).allow, false);
    assert.equal(c.guard(g, { command: 'echo x > money/payouts.js', cwd: ws }).allow, false);
    assert.equal(c.guard(c.agents.C5, { file: 'money/payouts.js', cwd: ws }).allow, true);
    assert.equal(c.guard(c.agents.C5, { file: 'money/refunds.js', cwd: ws }).allow, false);
    assert.equal(c.handoffs.size, 0);
    await tick();
    assert.match(c.agents[ORCH].queue.at(-1)?.text || sent.ORCH.at(-1), /\[HANDOFF #1 DONE\] C3 handed money\/payouts\.js, money\/payouts\.test\.js to C5/);
    await drain();
  });

  await test('handoff refused or overtaken: nothing moves and the receiver is free again', async () => {
    await c.rpc(ORCH, 'handoff', { from: 'C3', to: 'C6', files: ['money/refunds.js'], task: 'Refunds' });
    const box = await c.rpc('C3', 'read_messages', {});
    assert.match(box.text, /HANDOFF #2/);
    assert.equal(c.guard(c.agents.C3, { command: 'ls money', cwd: ws }).allow, true, 'already seen via read_messages: not held');
    assert.match((await c.rpc('C3', 'hand_over', { handoff: 2, notes: 'refunds and payments share one half-migrated table', refuse: true })).text, /You keep/);
    assert.equal(c.ownerOf(c.norm('money/refunds.js')), 'C3');
    assert.ok(c.isFree('C6'));
    await tick();
    await drain();
    // Giver finishes before handing over: the handoff is void and the report says so.
    await c.rpc(ORCH, 'handoff', { from: 'C3', to: 'C6', files: ['money/refunds.js'], task: 'Refunds' });
    finish('C3', 'REPORT\nDone: all of money');
    await tick();
    assert.match(sent.ORCH.at(-1), /REPORT FROM C3[\s\S]*handed off: money\/payouts\.js, money\/payouts\.test\.js → C5[\s\S]*Handoff #3 \(money\/refunds\.js → C6\) was cancelled: C3 finished before handing over/);
    assert.ok(c.isFree('C6'));
    await assert.rejects(c.rpc('C3', 'hand_over', { handoff: 3, notes: 'late' }), /No handoff #3/);
    finish('C5', 'REPORT\nDone: payouts');
    await tick();
    await drain();
  });

  await test('a back-and-forth between two workers opens a ticket for ORCH by itself', async () => {
    await c.rpc(ORCH, 'assign', { tasks: [{ agent: 'C4', task: 'Seed', owns: ['seed'] }, { agent: 'C6', task: 'Tests', owns: ['tests'] }] });
    await drain();
    const open = c.tickets.size;
    await c.rpc('C4', 'message_agent', { agent: 'C6', message: 'Disputed orders keep their tickets.' });
    await c.rpc('C6', 'message_agent', { agent: 'C4', message: 'No, void them. FINAL.' });
    assert.equal(c.tickets.size, open, 'two messages are just a conversation');
    await c.rpc('C4', 'message_agent', { agent: 'C6', message: 'I reverted your change, keeping them.' });
    assert.equal(c.tickets.size, open + 1);
    const t = [...c.tickets.values()].at(-1);
    assert.equal(t.from, null);
    assert.deepEqual(t.agents, ['C4', 'C6']);
    assert.match((await c.rpc('C4', 'read_messages', {})).text, /ORCH has been asked to rule/);
    assert.match((await c.rpc('C6', 'read_messages', {})).text, /ORCH has been asked to rule/);
    await tick();
    assert.match(c.agents[ORCH].queue.at(-1)?.text || sent.ORCH.at(-1), /DISPUTE \(raised by the hub\) · involves C4, C6[\s\S]*I reverted/);
    // More messages don't open a second ticket while it's open.
    await c.rpc('C6', 'message_agent', { agent: 'C4', message: 'FINAL, revert it back' });
    assert.equal(c.tickets.size, open + 1);
    await assert.rejects(c.rpc(ORCH, 'rule', { ticket: t.id, decision: 'x', grant_files: ['a'] }), /raised by the hub/);
    assert.match((await c.rpc(ORCH, 'rule', { ticket: t.id, decision: 'Void them: refunds must match the spec.' })).text, /C4 and C6 told/);
    assert.match((await c.rpc('C4', 'read_messages', {})).text, /ORCH RULING on #\d+[\s\S]*Void them/);
    assert.match((await c.rpc('C6', 'read_messages', {})).text, /Void them/);
    assert.match(c.ledger.Decisions, /auto-flagged dispute, C4, C6\): Void them/);
    // Plain coordination never trips it.
    const before = c.tickets.size;
    for (let i = 0; i < 4; i++) await c.rpc(i % 2 ? 'C1' : 'C2', 'message_agent', { agent: i % 2 ? 'C2' : 'C1', message: 'ok, the shape is {id, name}' });
    assert.equal(c.tickets.size, before);
    finish('C4', 'REPORT\nDone'); finish('C6', 'REPORT\nDone');
    await tick();
    await drain();
  });

  await test('ports per worker, and ORCH may write only the spec sections, which briefings list', async () => {
    assert.deepEqual(c.portRange('C1'), [4100, 4199]);
    assert.deepEqual(c.portRange('C6'), [4600, 4699]);
    assert.equal(c.portRange(ORCH), null);
    const o = c.agents[ORCH];
    assert.equal(c.guard(o, { file: '.cluster/spec/01-overview.md', cwd: ws }).allow, true);
    assert.equal(c.guard(o, { file: 'server/app.js', cwd: ws }).allow, false);
    fs.mkdirSync(path.join(ws, '.cluster', 'spec'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.cluster', 'spec', '01-overview.md'), 'x');
    fs.writeFileSync(path.join(ws, '.cluster', 'spec', '02-money.md'), 'x');
    await c.rpc(ORCH, 'assign', { tasks: [{ agent: 'C2', task: 'Read up', owns: ['web'] }] });
    assert.match(sent.C2.at(-1), /\.cluster[\\/]spec[\\/]01-overview\.md, \S*\.cluster[\\/]spec[\\/]02-money\.md[\s\S]*4200–4299/);
    finish('C2', 'REPORT\nDone');
    await tick();
    await drain();
  });

  // Make every worker free again (earlier tests leave fake busy flags behind).
  const freeAll = async () => {
    c.stop(ORCH);
    await tick();
    for (const id of IDS) Object.assign(c.agents[id], { busy: false, queue: [], current: null, tasks: [] });
    await drain();
  };
  const lastToOrch = () => c.agents[ORCH].queue.at(-1)?.text || sent.ORCH.at(-1);

  await test('queue: free workers start ready items themselves; after and team size are respected', async () => {
    await freeAll();
    const r = await c.rpc(ORCH, 'queue_work', { team_size: 2, items: [
      { name: 'setup', task: 'Scaffold', owns: ['app/package.json'] },
      { name: 'api', task: 'Build API', owns: ['app/api'], after: ['setup'] },
      { name: 'ui', task: 'Build UI', owns: ['app/ui'], after: ['setup'] },
      { name: 'docs', task: 'Write docs', owns: ['app/README.md'], after: ['api', 'ui'] },
      { name: 'bad', task: 'x', owns: [], after: ['nope'] },
    ] });
    assert.match(r.text, /Queued: setup, api, ui, docs\./);
    assert.match(r.text, /bad: "after" names unknown item\(s\): nope/);
    assert.match(r.text, /Started now: "setup" → C1/);
    assert.equal(c.assignments.size, 1);
    assert.match(sent.C1.at(-1), /\[ASSIGNMENT FROM ORCH\] "setup"\nScaffold/);
    // setup reports: api and ui start at once on free workers; team size 2 holds the rest; docs waits for both.
    finish('C1', 'REPORT\nDone: scaffold');
    await tick();
    assert.deepEqual([...c.assignments].map(([id, j]) => `${id}:${j.item}`).sort(), ['C1:api', 'C2:ui']);
    const note = lastToOrch();
    assert.match(note, /queue item "setup", now marked done/);
    assert.match(note, /Auto-started from the queue: "api" → C1 \(same session\), "ui" → C2/);
    assert.match(note, /QUEUE \(team size 2\): 2 running \(api on C1, ui on C2\), 0 ready, 1 waiting \(docs after api\+ui\), 1 done/);
    assert.doesNotMatch(note, /REBALANCE/, 'free workers outside the team size are not a problem');
    assert.match(fs.readFileSync(path.join(ws, '.cluster', 'ledger.md'), 'utf8'), /## Queue \(automatic\)\n- setup \[done by C1(, critical)?\]/);
    await assert.rejects(c.rpc('C2', 'queue_work', { items: [] }), /orchestrator/);
    assert.match((await c.rpc(ORCH, 'queue_work', { items: [{ name: 'ui', task: 'again', owns: [] }] })).text, /ui: running on C2/);
    finish('C1', 'REPORT\nDone: api');
    await tick();
    assert.equal(c.assignments.size, 1, 'docs still waits for ui');
    finish('C2', 'REPORT\nDone: ui');
    await tick();
    assert.deepEqual([...c.assignments].map(([id, j]) => `${id}:${j.item}`), ['C1:docs']);
    finish('C1', 'REPORT\nDone: docs');
    await tick();
    assert.match(lastToOrch(), /0 running, 0 ready, 0 waiting, 4 done\. Nothing left in the queue/);
    // A named assign joins the queue, so queued work can wait for it.
    await c.rpc(ORCH, 'queue_work', { team_size: 6 });
    await c.rpc(ORCH, 'assign', { tasks: [{ agent: 'C4', name: 'core', task: 'Core', owns: ['core'], model: 'sonnet' }] });
    assert.equal(c.agents.C4.jobModel, 'sonnet');
    const q = await c.rpc(ORCH, 'queue_work', { items: [{ name: 'pages', task: 'Pages', owns: ['pages2'], after: ['core'] }] });
    assert.match(q.text, /1 waiting \(pages after core\)/);
    finish('C4', 'REPORT\nDone: core');
    await tick();
    assert.equal(c.assignments.values().next().value?.item, 'pages');
    finish([...c.assignments.keys()][0], 'REPORT\nDone');
    await tick();
    await drain();
  });

  await test('task cards: plan check, critical first, builder keeps its session, prior reports in briefings, handoff files, metrics', async () => {
    await freeAll();
    const r = await c.rpc(ORCH, 'queue_work', { team_size: 1, items: [
      { name: 'side', task: 'Side work', owns: ['t/side'], priority: 'filler' },
      { name: 'db', task: 'DB layer', owns: ['t/db'], provides: ['db.ts: getOrder'], done_when: 'db tests pass', priority: 'critical' },
      { name: 'feat', task: 'Feature on the DB', owns: ['t/feat'], after: ['db'] },
      { name: 'dup', task: 'Dup', owns: ['t/db/x.js'] },
      { name: 'loopA', task: 'A', owns: [], after: ['loopB'] },
      { name: 'loopB', task: 'B', owns: [], after: ['loopA'] },
    ] });
    assert.match(r.text, /loopB: waiting for "loopA" would make a loop/);
    assert.match(r.text, /Plan check:[\s\S]*"db" and "dup" both own t\/db/);
    assert.match(r.text, /Started now: "db" → C1\./, 'critical goes first, before earlier-queued filler');
    assert.match(sent.C1.at(-1), /Done when \(check each before you report\): db tests pass/);
    assert.match(sent.C1.at(-1), /You provide: db\.ts: getOrder/);
    assert.match(sent.C1.at(-1), /critical path/);
    finish('C1', 'Working notes...\nREPORT\nDone: db layer\nChanged files: t/db/db.ts (getOrder)');
    await tick();
    assert.equal(c.assignments.get('C1')?.item, 'feat', 'normal before filler; the builder of db takes feat');
    assert.match(sent.C1.at(-1), /What the work you build on reported[\s\S]*### db \(built by C1\)\nREPORT\nDone: db layer/);
    assert.doesNotMatch(sent.C1.at(-1), /Working notes/);
    assert.match(sent.C1.at(-1), /continues your previous session/);
    assert.match(fs.readFileSync(path.join(ws, '.cluster', 'handoffs', 'db.md'), 'utf8'), /# db \(built by C1\)/);
    await c.rpc(ORCH, 'queue_work', { remove: ['side', 'dup', 'loopA'], team_size: 6 });
    await c.rpc('C1', 'set_tasks', { tasks: ['a', 'b', 'c'] });
    for (const i of [1, 2, 3]) await c.rpc('C1', 'update_task', { index: i, status: 'completed' });
    assert.match(lastToOrch(), /\[HEADS-UP\] C1 is nearly done \(3\/3 tasks\)/);
    finish('C1', 'REPORT\nDone: feature');
    await tick();
    const runs = path.join(ws, '.cluster', 'runs');
    const m = JSON.parse(fs.readFileSync(path.join(runs, fs.readdirSync(runs)[0], 'metrics.json'), 'utf8'));
    assert.ok(m.itemsDone >= 2 && 'idleShare' in m && 'planningSeconds' in m);
    assert.match(c.statsText(), /Planning \(instruction → first assignment\)/);
    await drain();
  });

  await test('read_messages: waiting is capped, and refused while tasks are unstarted; ALL reaches working workers', async () => {
    await freeAll();
    const w = c.agents.C4;
    w.busy = true;
    w.tasks = [{ text: 'a', status: 'in_progress' }, { text: 'b', status: 'pending' }];
    let t = Date.now();
    assert.match((await c.rpc('C4', 'read_messages', { wait_seconds: 120 })).text, /1 task\(s\) not started, so don't wait/);
    assert.ok(Date.now() - t < 500);
    w.tasks = [{ text: 'a', status: 'in_progress' }];
    c.cfg.maxWaitSeconds = 1;
    t = Date.now();
    assert.equal((await c.rpc('C4', 'read_messages', { wait_seconds: 120 })).text, 'No messages.');
    assert.ok(Date.now() - t < 2500, 'capped at maxWaitSeconds');
    c.cfg.maxWaitSeconds = 20;
    c.agents.C5.busy = true;
    assert.match((await c.rpc('C6', 'message_agent', { agent: 'ALL', message: 'orders.ts exports ready' })).text, /Sent to C4, C5\./);
    assert.match((await c.rpc('C5', 'read_messages', {})).text, /From C6 \(message\): orders\.ts exports ready/);
    c.agents.C5.busy = false;
    w.busy = false;
  });

  await test('check: heavy commands are routed to the shared queue; run and types work', async () => {
    const w = c.agents.C2;
    const deny = c.guard(w, { command: 'cd app && npx tsc --noEmit', cwd: ws });
    assert.equal(deny.allow, false);
    assert.match(deny.reason, /mcp__cluster__check/);
    assert.equal(c.guard(w, { command: 'npm run build', cwd: ws }).allow, false);
    assert.equal(c.guard(w, { command: 'cat tsconfig.json; ls node_modules', cwd: ws }).allow, true);
    assert.equal(c.guard(w, { command: 'npx tsc --version', cwd: ws }).allow, true);
    assert.equal(c.guard(c.agents[ORCH], { command: 'npm test', cwd: ws }).allow, true, 'ORCH verifies with its own runs');
    c.cfg.routeChecks = false;
    assert.equal(c.guard(w, { command: 'npm test', cwd: ws }).allow, true);
    c.cfg.routeChecks = true;
    const r = await c.rpc('C2', 'check', { kind: 'run', command: 'echo "hello on $PORT"' });
    assert.match(r.text, /^Exit code 0 · \d+s\nhello on 4200/);
    assert.match((await c.rpc('C2', 'check', { kind: 'run', command: 'exit 3' })).text, /^Exit code 3/);
    assert.match((await c.rpc('C2', 'check', { kind: 'types' })).text, /No shared type checker/);
    await assert.rejects(c.rpc('C2', 'check', { kind: 'run', folder: '..', command: 'echo x' }), /inside the project/);
    // Only `slots` heavy commands run at once; the rest queue.
    c.checks.slots = 1;
    const t0 = Date.now();
    const runs = await Promise.all([1, 2, 3].map(() => c.rpc('C2', 'check', { kind: 'run', command: 'sleep 0.4' })));
    assert.ok(Date.now() - t0 >= 1100, 'ran one at a time');
    assert.ok(runs.every(x => /^Exit code 0/.test(x.text)));
    c.checks.slots = 2;
  });

  await test('guard as an HTTP hook: agents get an http hook; the hub answers like hook-guard.js', async () => {
    await c.start();
    const st = JSON.parse(fs.readFileSync(c.writeAgentFiles(c.agents.C2).settings, 'utf8'));
    const h = st.hooks.PreToolUse[0].hooks[0];
    assert.equal(h.type, 'http');
    assert.equal(h.url, `http://127.0.0.1:${c.port}/hook`);
    const post = (agent, token, ev) => new Promise((res, rej) => {
      const req = require('http').request({ host: '127.0.0.1', port: c.port, path: '/hook', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CT-Agent': agent, 'X-CT-Token': token } }, rsp => {
        let d = ''; rsp.on('data', x => { d += x; }); rsp.on('end', () => res({ status: rsp.statusCode, body: d }));
      });
      req.on('error', rej);
      req.end(JSON.stringify(ev));
    });
    c.owners.set(c.norm('owned/by-c3.js'), 'C3');
    const ev = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'owned/by-c3.js', content: 'x' }, cwd: ws };
    const denied = await post('C2', c.token, ev);
    assert.equal(denied.status, 200);
    assert.equal(JSON.parse(denied.body).hookSpecificOutput.permissionDecision, 'deny');
    assert.match(JSON.parse(denied.body).hookSpecificOutput.permissionDecisionReason, /owned by C3/);
    assert.equal((await post('C3', c.token, ev)).body, '', 'the owner is allowed (empty reply)');
    assert.equal((await post('C2', 'wrong', ev)).body, '', 'bad token: no decision');
    c.cfg.guardHook = 'command';
    assert.equal(JSON.parse(fs.readFileSync(c.writeAgentFiles(c.agents.C2).settings, 'utf8')).hooks.PreToolUse[0].hooks[0].type, 'command');
    c.cfg.guardHook = 'http';
  });

  await test('a PDF in an orch instruction is turned into text before ORCH starts', async () => {
    // A one-page PDF saying "Hello spec", in a folder with spaces and brackets in its name.
    const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
      '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>', '<</Length 40>>stream\nBT /F1 12 Tf 20 50 Td (Hello spec) Tj ET\nendstream'];
    let pdf = '%PDF-1.4\n';
    const offs = objs.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
    const dir = path.join(tmp, 'my specs');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'Spec Doc (v2).pdf');
    fs.writeFileSync(file, pdf, 'latin1');
    await drain();
    c.userSend(ORCH, `Build the spec in ${file} (1 page) quickly.`);
    const msg = sent.ORCH.at(-1);
    assert.match(msg, /\[CLUSTER TERMINAL NOTE\][\s\S]*\.cluster[\\/]spec[\\/]source-spec-doc-v2\.txt \(1 pages/);
    assert.match(fs.readFileSync(path.join(ws, '.cluster', 'spec', 'source-spec-doc-v2.txt'), 'utf8'), /Hello spec/);
    assert.equal(c.prepSpec('no pdf here, and missing.pdf'), '');
    // A PDF inside a named folder is found too.
    assert.match(c.prepSpec(`Build the site in ${dir} please.`), /source-spec-doc-v2/);
    await drain();
    // Briefings point at the sections, and at the full text only as a fallback.
    await freeAll();
    await c.rpc(ORCH, 'assign', { tasks: [{ agent: 'C6', task: 'Read up', owns: ['web6'] }] });
    assert.match(sent.C6.at(-1), /01-overview\.md, \S*\.cluster[\\/]spec[\\/]02-money\.md[^\n]*\n[^\n]*search: \S*\.cluster[\\/]spec[\\/]source-spec-doc-v2\.txt\. Never open the original PDF/);
    finish('C6', 'REPORT\nDone');
    await tick();
    await drain();
  });

  await test('/stats: per-agent time by kind, assignments timeline, saved to .cluster/stats.md', async () => {
    c.resetStats();
    assert.match(c.statsText(), /nothing yet/);
    c.userSend(ORCH, 'go');
    await drain();
    const a = c.agents.C3;
    a.handle({ type: 'assistant', message: { id: 'm1', usage: { output_tokens: 2500 }, content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npx vitest run' } },
      { type: 'tool_use', id: 't2', name: 'mcp__cluster__read_messages', input: { wait_seconds: 20 } },
      { type: 'tool_use', id: 't3', name: 'Write', input: { file_path: 'x.js', content: 'x' } },
    ] } });
    c.pendingTools.get('t1').t -= 120000;
    c.pendingTools.get('t2').t -= 30000;
    a.handle({ type: 'user', message: { content: ['t1', 't2', 't3'].map(id => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })) } });
    a.turnT = Date.now() - 300000;
    c.statTurn(a);
    const s = c.statsText();
    assert.match(s, /RUN STATS · started \d\d:\d\d:\d\d/);
    assert.match(s, /\nC3  busy 5\.0m · thinking 2\.5m · build\/test 2\.0m · waiting 0\.5m\n    first edit \+0:00 · finished \+\d+:\d\d · 1 turn\(s\) · 0 msgs sent · 3k tokens out/);
    assert.equal(c.statCategory('Read', { file_path: 'C:/x/Spec.pdf' }), 'spec');
    assert.equal(c.statCategory('mcp__cluster__check', {}), 'build/test');
    c.userSend(ORCH, '/stats');
    assert.match(c.log.at(-1).text, /^RUN STATS/);
    assert.equal(c.log.at(-1).role, 'sys');
    assert.match(fs.readFileSync(path.join(ws, '.cluster', 'stats.md'), 'utf8'), /C3  busy 5\.0m/);
    c.userSend(ORCH, '/stats reset');
    assert.match(c.statsText(), /nothing yet/);
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
    assert.equal(c2.ownerOf(c2.norm('owned/by-c3.js')), 'C3');
    assert.deepEqual(c2.backlog.map(b => b.name + ':' + b.state), ['setup:done', 'api:done', 'ui:done', 'docs:done', 'core:done', 'pages:done', 'db:done', 'feat:done']);
    assert.match(c2.ledger.Goal, /Todo app/);
  });

  await test('stop: ORCH halts workers at once, without reports; queue parked or cleared', async () => {
    await freeAll();
    c.queueHeld = false;
    const r = await c.rpc(ORCH, 'queue_work', { team_size: 2, integration_check: 'echo ok', items: [
      { name: 's1', task: 'Stop me one', owns: ['stop1'] },
      { name: 's2', task: 'Stop me two', owns: ['stop2'] },
      { name: 's3', task: 'After one', owns: ['stop3'], after: ['s1'] },
    ] });
    assert.match(r.text, /Started now: "s1" → (C\d), "s2" → (C\d)/);
    const [, w1, w2] = r.text.match(/"s1" → (C\d), "s2" → (C\d)/);
    const before = c.agents[ORCH].queue.length + sent.ORCH.length;
    await assert.rejects(c.rpc(w2, 'stop', {}), /orchestrator/);
    const s = await c.rpc(ORCH, 'stop', { agents: [w1], clear_queue: false });
    assert.ok(s.text.startsWith('Stopped: ' + w1 + ' (was on "s1": Stop me one)'), s.text);
    assert.match(s.text, /1 running \(s2 on C\d\)[\s\S]*1 stopped \(s1\)/);
    await tick();
    assert.equal(c.agents[ORCH].queue.length + sent.ORCH.length, before, 'no fake report reaches ORCH');
    assert.equal(c.backlog.find(b => b.name === 's1').state, 'stopped');
    assert.equal(c.backlog.find(b => b.name === 's3').state, 'queued', 's3 waits on the stopped item');
    assert.ok(!c.assignments.has(w1) && c.assignments.has(w2) && c.integration);
    assert.equal(c.agents[w1].status(), 'IDLE');
    assert.ok(c.isFree(w1) && !c.agents[w1].sessionId);
    const all = await c.rpc(ORCH, 'stop', {});
    assert.ok(all.text.startsWith('Stopped: ' + w2 + ' (was on "s2"') && /Queue cleared [(]3 unfinished[^]*Integration check turned off/.test(all.text), all.text);
    assert.ok(!c.assignments.size && !c.integration && !c.backlog.some(b => b.state !== 'done'));
    assert.ok(IDS.every(id => c.isFree(id) && c.agents[id].status() === 'IDLE'));
    // Stopped workers take fresh work right away.
    assert.match((await c.rpc(ORCH, 'assign', { tasks: [{ agent: w1, task: 'Fresh', owns: ['stop1'] }] })).text, new RegExp(w1));
    await c.rpc(ORCH, 'stop', { agents: [w1] });
  });

  await test('model tiers, batched notices to ORCH, briefing paths and the setup note', async () => {
    await freeAll();
    const cfg = c.cfg;
    assert.equal(c.tierModel({ priority: 'critical' }), cfg.criticalModel || null);
    assert.equal(c.tierModel({}), cfg.workerModel || null);
    assert.equal(c.tierModel({ priority: 'critical', model: 'haiku' }), 'haiku');
    // Notices to an idle ORCH wait a moment so several arrive as one message; a ticket goes at once.
    cfg.orchBatchSeconds = 0.05;
    const before = sent.ORCH.length;
    c.notifyOrch('first notice');
    c.notifyOrch('second notice');
    assert.equal(sent.ORCH.length, before);
    await new Promise(r => setTimeout(r, 120));
    assert.equal(sent.ORCH.length, before + 1);
    assert.match(sent.ORCH.at(-1), /first notice[\s\S]*second notice/);
    await drain();
    c.notifyOrch('held');
    c.notifyOrch('urgent ticket', true);
    assert.match(sent.ORCH.at(-1), /held[\s\S]*urgent ticket/);
    assert.equal(c.orchHold, null);
    cfg.orchBatchSeconds = 0;
    await drain();
    // Builders don't wait on setup: a running critical item is named, with the full .cluster path.
    await c.rpc(ORCH, 'queue_work', { items: [
      { name: 'setup', task: 'Scaffold', owns: ['s/setup'], priority: 'critical' },
      { name: 'page', task: 'Page', owns: ['s/page'] },
    ] });
    const page = IDS.find(id => c.assignments.get(id)?.item === 'page');
    assert.ok(page, 'the first wave starts beside setup');
    assert.match(sent[page].at(-1), /Still being set up: "setup" \(C\d[\s\S]*Don't wait for it/);
    assert.ok(sent[page].at(-1).includes(path.join(ws, '.cluster')));
    await freeAll();
    await c.rpc(ORCH, 'queue_work', { remove: ['setup', 'page'] });
  });

  const clearQueue = async () => { await freeAll(); c.assignments.clear(); c.backlog = []; c.owners.clear(); c.claims.clear(); c.splitDeclined = {}; if (c.splitAsk) clearTimeout(c.splitAsk.timer); c.splitAsk = null; };
  const runner = name => c.backlog.find(b => b.name === name)?.agent;

  await test('propose_work: a worker adds work it found; a free worker starts it, ORCH hears', async () => {
    await clearQueue();
    await c.rpc(ORCH, 'queue_work', { team_size: 4, items: [{ name: 'pa', task: 'Piece A', owns: ['pw/a'] }, { name: 'pb', task: 'Piece B', owns: ['pw/b'] }] });
    const wa = runner('pa'), wb = runner('pb');
    const r = await c.rpc(wa, 'propose_work', { items: [
      { name: 'helper', task: 'Shared date helper', owns: ['pw/helper'] },
      { name: 'grab', task: 'Touch B', owns: ['pw/b/x.js'] },
      { name: 'follow', task: 'A follow-up', owns: ['pw/a/extra.js'] },
      { name: 'pa', task: 'Rename clash', owns: ['pw/z'] },
    ] });
    assert.match(r.text, /"helper" started on C\d/);
    assert.notEqual(runner('helper'), wa);
    assert.match(r.text, new RegExp(`grab: pw/b/x\\.js overlaps ${wb}`));
    assert.match(r.text, /"follow" queued \(it uses your files, so it starts once you report\)/);
    assert.match(r.text, /pa: (running on|that name)/);
    assert.equal(c.backlog.find(b => b.name === 'helper').proposedBy, wa);
    await drain();
    assert.ok(sent.ORCH.some(m => /\[PROPOSED BY C\d\] queued "helper"/.test(m)));
    await assert.rejects(c.rpc(ORCH, 'propose_work', { items: [] }), /workers/);
  });

  await test('mark_ready: waiting items start on the interface, unless wait_for_done', async () => {
    await clearQueue();
    await c.rpc(ORCH, 'queue_work', { team_size: 4, items: [
      { name: 'api', task: 'Build API', owns: ['mr/api'], priority: 'critical' },
      { name: 'ui', task: 'Build UI', owns: ['mr/ui'], after: ['api'] },
      { name: 'e2e', task: 'Test the finished API', owns: ['mr/e2e'], after: ['api'], wait_for_done: true },
      { name: 'side', task: 'Side', owns: ['mr/side'] },
    ] });
    const wa = runner('api'), ws2 = runner('side');
    assert.equal(c.backlog.find(b => b.name === 'ui').state, 'queued');
    const r = await c.rpc(wa, 'mark_ready', { summary: 'mr/api/index.ts exports listTodos()' });
    assert.match(r.text, /Started on it now: "ui" on C\d/);
    const wu = runner('ui');
    assert.match(sent[wu].at(-1), /### api \(interface ready; C\d is still finishing[\s\S]*listTodos/);
    assert.equal(c.backlog.find(b => b.name === 'e2e').state, 'queued', 'wait_for_done waits for the report');
    assert.ok(c.mail[ws2].some(m => /\[INTERFACE READY\] C\d \("api"\): mr\/api/.test(m.text)));
    assert.match(c.queueSummary(), /api on C\d, interface ready/);
    finish(wa, 'REPORT\nDone: api');
    await tick();
    assert.equal(c.backlog.find(b => b.name === 'e2e').state, 'running');
    await drain();
  });

  await test('split: the hub asks the busy owner; it names the part, which starts on a free worker', async () => {
    await clearQueue();
    c.cfg.splitMinWorkSeconds = 0;
    await c.rpc(ORCH, 'queue_work', { team_size: 3, items: [
      { name: 'big', task: 'Big piece', owns: ['sp/big'], priority: 'critical' },
      { name: 'later', task: 'Needs big', owns: ['sp/later'], after: ['big'] },
    ] });
    const wb = runner('big');
    assert.equal(c.splitAsk, null, 'no task list yet, so nothing to ask about');
    await c.rpc(wb, 'set_tasks', { tasks: ['models', 'routes', 'admin page', 'tests'] });
    await c.rpc(wb, 'update_task', { index: 1, status: 'in_progress' });
    c.dispatch();
    assert.equal(c.splitAsk?.from, wb);
    // status shows task lists
    assert.match((await c.rpc('C6', 'cluster_status', {})).text, new RegExp(`${wb}: .*"big".* tasks 0/4 · left: ▶ models; routes`));
    assert.match(c.loadBoard(), new RegExp(`SPLIT: the hub has asked ${wb}`));
    // its next step is held once so it sees the request
    const g = c.guard(c.agents[wb], { file: path.join(ws, 'sp/big/models.js') });
    assert.equal(g.allow, false);
    assert.match(g.reason, /SPLIT REQUEST FROM THE HUB/);
    assert.notEqual(c.guard(c.agents[wb], { file: path.join(ws, 'sp/big/models.js') }).allow, false);
    c.owners.set(c.norm('sp/theirs'), wb === 'C6' ? 'C5' : 'C6');
    await assert.rejects(c.rpc(wb, 'offer_split', { files: ['sp/theirs'], task: 'x' }), /not you/);
    const r = await c.rpc(wb, 'offer_split', { files: ['sp/big/admin'], task: 'Build the admin page', notes: 'Use models from sp/big/models.js', done_when: 'admin page renders' });
    const part = c.backlog.find(b => b.splitFrom === wb);
    assert.ok(part && part.state === 'running' && part.agent !== wb, 'the part starts on a free worker');
    assert.match(r.text, new RegExp(`now belong to ${part.agent}`));
    assert.equal(c.ownerOf(c.norm('sp/big/admin/page.js')), part.agent);
    assert.equal(c.ownerOf(c.norm('sp/big/models.js')), wb);
    assert.equal(part.priority, 'critical');
    assert.ok(c.backlog.find(b => b.name === 'later').after.includes(part.name), 'work after big also waits for the part');
    assert.match(sent[part.agent].at(-1), /Split off by C\d[\s\S]*Use models from/);
    assert.equal(c.splitAsk, null);
    await drain();
    assert.ok(sent.ORCH.some(m => /\[SPLIT\] C\d split off "big-part\d+"/.test(m)));
    // "nothing separable" puts the owner on cooldown
    await c.rpc(wb, 'offer_split', { none: true, notes: 'tightly linked' });
    assert.ok(c.splitDeclined[wb]);
    c.dispatch();
    assert.notEqual(c.splitAsk?.from, wb);
    c.cfg.splitMinWorkSeconds = 60;
    await clearQueue();
  });

  await test('timed critical path: longest chain first, hub marks it critical, early split, metrics items', async () => {
    // (a) a 12-min item with one item behind beats a 2-min item with three small items behind
    await clearQueue();
    await c.rpc(ORCH, 'queue_work', { team_size: 1, items: [
      { name: 'quick', task: 'Quick one', owns: ['tc/quick'], est_minutes: 2 },
      { name: 'q1', task: 'q1', owns: ['tc/q1'], after: ['quick'] },
      { name: 'q2', task: 'q2', owns: ['tc/q2'], after: ['quick'] },
      { name: 'q3', task: 'q3', owns: ['tc/q3'], after: ['quick'] },
      { name: 'slow', task: 'Slow one', owns: ['tc/slow'], est_minutes: 12 },
      { name: 's1', task: 's1', owns: ['tc/s1'], after: ['slow'] },
    ] });
    assert.ok(runner('slow'), 'the 12-minute item starts first');
    assert.equal(c.backlog.find(b => b.name === 'quick').state, 'queued');
    assert.equal(c.downstream('slow'), 17, 'own 12 + the item behind it (default 5)');
    assert.equal(c.downstream('quick'), 7, 'own 2 + the longest chain behind it (three parallel items count once, not summed)');

    // (b) the hub marks the longest chain critical itself
    await clearQueue();
    await c.rpc(ORCH, 'queue_work', { team_size: 1, items: [
      { name: 'side', task: 'Side', owns: ['tb/side'], est_minutes: 2 },
      { name: 'head', task: 'Head of chain', owns: ['tb/head'], est_minutes: 8 },
      { name: 'tail', task: 'Tail of chain', owns: ['tb/tail'], after: ['head'], est_minutes: 8 },
    ] });
    assert.equal(c.backlog.find(b => b.name === 'head').priority, 'critical');
    assert.notEqual(c.backlog.find(b => b.name === 'side').priority, 'critical');
    assert.ok(runner('head'));

    // (c) a critical item estimated at 6+ minutes gets an early split request, without a task list
    await clearQueue();
    c.cfg.splitMinWorkSeconds = 0;
    await c.rpc(ORCH, 'queue_work', { team_size: 3, items: [
      { name: 'bigcrit', task: 'Big critical', owns: ['tcs/big'], priority: 'critical', est_minutes: 8 },
      { name: 'after-big', task: 'Needs it', owns: ['tcs/after'], after: ['bigcrit'] },
    ] });
    const wbig = runner('bigcrit');
    c.dispatch();
    assert.equal(c.splitAsk?.from, wbig, 'early split request to the 8-minute critical item');
    assert.equal(c.agents[wbig].tasks.length, 0);
    await clearQueue();
    await c.rpc(ORCH, 'queue_work', { team_size: 3, items: [
      { name: 'smallcrit', task: 'Small critical', owns: ['tcs/small'], priority: 'critical', est_minutes: 3 },
      { name: 'after-small', task: 'Needs it', owns: ['tcs/after2'], after: ['smallcrit'] },
    ] });
    c.dispatch();
    assert.equal(c.splitAsk, null, 'a 3-minute item is not worth an early split');
    c.cfg.splitMinWorkSeconds = 60;

    // (d) metrics.json items list: estimated and actual minutes
    await clearQueue();
    c.stats.t0 ||= Date.now();
    await c.rpc(ORCH, 'queue_work', { team_size: 2, items: [
      { name: 'm-est', task: 'Estimated', owns: ['tm/a'], est_minutes: 7 },
      { name: 'm-default', task: 'Default estimate', owns: ['tm/b'] },
    ] });
    const we = runner('m-est'), wd = runner('m-default');
    finish(we, 'REPORT\nDone: est');
    finish(wd, 'REPORT\nDone: default');
    await tick();
    const items = c.metrics().items;
    assert.ok(Array.isArray(items));
    const ie = items.find(i => i.name === 'm-est'), id2 = items.find(i => i.name === 'm-default');
    assert.ok(ie && id2, 'both items are listed');
    assert.equal(ie.est_minutes, 7);
    assert.equal(id2.est_minutes, 5);
    assert.equal(ie.agent, we);
    assert.ok(typeof ie.actual_minutes === 'number' && ie.actual_minutes >= 0);
    assert.ok('critical' in ie && 'model' in ie);
    await clearQueue();
  });

  await test('no make-work: test/verify/audit items flagged, workers cannot propose them; shell file writes refused', async () => {
    c.addItems([{ name: 'core-audit', task: 'Audit core', owns: ['audit-notes'] }]);
    assert.match(c.planWarnings().join('\n'), /"core-audit" looks like a separate test\/verify\/audit job/);
    c.backlog = c.backlog.filter(b => b.name !== 'core-audit');
    const wx = IDS.find(x => c.isFree(x));
    await c.rpc(ORCH, 'assign', { tasks: [{ agent: wx, task: 'Build x', owns: ['xmod'] }] });
    const p = await c.rpc(wx, 'propose_work', { items: [{ name: 'xmod-tests', task: 'Test x', owns: ['xtests'] }] });
    assert.match(p.text, /belong to the builder/);
    const g = c.guard(c.agents[wx], { command: "cat > xmod/a.js <<'EOF'\nconst a = '\\\\';\nEOF" });
    assert.equal(g.allow, false);
    assert.match(g.reason, /Write tool/);
    assert.equal(c.guard(c.agents[wx], { command: 'node xmod/a.js > out.txt' }).allow, true);
    finish(wx, 'REPORT\nDone');
    await tick();
  });

  await test('review item: owns nothing, edits refused, waits for the finished piece', async () => {
    await c.rpc(ORCH, 'queue_work', { items: [{ name: 'piece-r', task: 'Build r', owns: ['rmod'] }, { name: 'spot-check', task: 'Check r against the spec', owns: ['rmod'], after: ['piece-r'], review: true }] });
    const rev = c.backlog.find(b => b.name === 'spot-check');
    assert.deepEqual(rev.owns, []);
    assert.equal(rev.waitForDone, true);
    const builder = c.backlog.find(b => b.name === 'piece-r').agent;
    await c.rpc(builder, 'mark_ready', { summary: 'rmod exports r(); r(1) -> 2' });
    assert.equal(rev.state, 'queued');
    finish(builder, 'REPORT\nDone: r');
    await tick();
    assert.equal(rev.state, 'running');
    const reviewer = c.agents[rev.agent];
    assert.match(sent[rev.agent].at(-1), /This is a REVIEW/);
    assert.equal(c.guard(reviewer, { file: path.join(ws, 'rmod', 'r.js') }).allow, false);
    finish(rev.agent, 'REPORT\nDone: no gaps');
    await tick();
    assert.equal(rev.state, 'done');
    void reviewer;
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
    assert.ok(orchTools.includes('assign') && orchTools.includes('handoff') && orchTools.includes('rule') && !orchTools.includes('escalate') && !orchTools.includes('hand_over'));
    assert.ok(worker.includes('hand_over') && !worker.includes('handoff') && worker.includes('check') && !worker.includes('queue_work'));
    assert.ok(orchTools.includes('queue_work') && orchTools.includes('stop') && !worker.includes('stop') && solo.includes('check'));
    assert.ok(worker.includes('escalate') && worker.includes('read_messages') && !worker.includes('assign') && !worker.includes('ask_agent'));
    assert.ok(solo.includes('ask_agent') && !solo.includes('escalate') && !solo.includes('dispatch'));
    assert.ok(['propose_work', 'offer_split', 'mark_ready'].every(t => worker.includes(t) && !orchTools.includes(t) && !solo.includes(t)));
  });

  console.log(`\n${n} tests passed`);
  c.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
