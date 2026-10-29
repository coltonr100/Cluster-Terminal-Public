'use strict';
// Demo mode: fake agents that send the same events as the real cluster, so the
// screen can be shown off without using any Claude usage.

const { EventEmitter } = require('events');
const { IDS } = require('./orchestrator');

const ORCH = 'ORCH';
const ALL = [...IDS, ORCH];

const TASKS = [
  'Map the existing schema', 'Write migration for orders table', 'Add index on customer_id', 'Build REST endpoint /api/orders',
  'Wire up input validation', 'Write unit tests for parser', 'Refactor auth middleware', 'Profile slow query', 'Update README',
  'Add retry logic to fetcher', 'Render chart component', 'Fix timezone bug in reports', 'Seed test database', 'Lint and format',
];

const ORCH_TASKS = [
  'Map the system and its seams', 'Write contracts to the ledger', 'Assign owners and files', 'Review reports as they land',
  'Rule on open disputes', 'Run the integration check', 'Report to the operator',
];

const FEED = [
  ['sql', 'SELECT c.id, c.region, SUM(o.total) AS revenue\nFROM customers c\nJOIN orders o ON o.customer_id = c.id\nWHERE o.created_at >= DATE(\'now\', \'-30 day\')\nGROUP BY c.id, c.region\nORDER BY revenue DESC\nLIMIT 25;'],
  ['sql', 'CREATE INDEX IF NOT EXISTS idx_orders_customer\n  ON orders (customer_id, created_at);'],
  ['sql', 'UPDATE refinement_bins SET status = \'complete\'\nWHERE file_id = 4471 AND quota_met = 1;'],
  ['run', '$ npm test -- --runInBand'],
  ['out', 'PASS  src/parser.test.js (24 tests)\nPASS  src/orders.test.js (11 tests)'],
  ['run', '$ python -m pytest tests/ -q'],
  ['out', '.................................. 34 passed in 2.81s'],
  ['code', 'EDIT src/api/orders.js\nconst express = require(\'express\');\nconst db = require(\'../db\');\nconst router = express.Router();\n\nrouter.get(\'/orders/:id\', async (req, res) => {\n  const order = await db.orders.find(req.params.id);\n  if (!order) return res.status(404).json({ error: \'not found\' });\n  res.json(order);\n});\n\nrouter.post(\'/orders\', validate(orderSchema), async (req, res) => {\n  const id = await db.orders.insert(req.body);\n  res.status(201).json({ id });\n});\n\nmodule.exports = router;'],
  ['code', 'WRITE src/util/retry.js\n// Retry an async call with exponential backoff.\nconst sleep = ms => new Promise(r => setTimeout(r, ms));\n\nexport async function retry(fn, tries = 3, wait = 250) {\n  for (let i = 0; i < tries; i++) {\n    try { return await fn(); }\n    catch (e) {\n      if (i === tries - 1) throw e;\n      await sleep(wait * 2 ** i);\n    }\n  }\n}'],
  ['code', 'EDIT reports/tz.py\nfrom zoneinfo import ZoneInfo\n\nCENTRAL = ZoneInfo("America/Chicago")\n\n\ndef to_central(ts):\n    """Convert an aware timestamp to Central time."""\n    return ts.astimezone(CENTRAL)\n\n\ndef day_bounds(day):\n    start = datetime.combine(day, time.min, CENTRAL)\n    return start, start + timedelta(days=1)'],
  ['code', 'WRITE src/components/Chart.jsx\nimport { useMemo } from \'react\';\n\nexport default function Chart({ rows }) {\n  const max = useMemo(() => Math.max(1, ...rows.map(r => r.value)), [rows]);\n  return (\n    <svg viewBox="0 0 300 120">\n      {rows.map((r, i) => (\n        <rect key={r.id} x={i * 12} width={10}\n          y={120 - r.value / max * 120}\n          height={r.value / max * 120} />\n      ))}\n    </svg>\n  );\n}'],
  ['io', 'READ src/db/schema.sql'],
  ['io', 'GREP "customer_id"  in src/'],
  ['run', 'PS> Get-ChildItem -Recurse -Filter *.sql | Measure-Object'],
  ['net', '>> UPDATE_TASK {"index":2,"status":"completed"}'],
  ['run', '$ git diff --stat'],
  ['out', ' src/api/orders.js | 18 ++++++++++++------\n 1 file changed, 12 insertions(+), 6 deletions(-)'],
];

const pick = a => a[Math.floor(Math.random() * a.length)];
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const sorted = (x, y) => [x, y].sort();

class Demo extends EventEmitter {
  constructor() {
    super();
    this.timers = [];
    this.mode = 'individual';
    this.seq = 0;
    this.reset();
  }

  reset() {
    this.agents = Object.fromEntries(ALL.map(id => [id, {
      id, status: 'IDLE', busy: false, tasks: [], ctx: 0, used: 0, connected: [], watch: 'NOMINAL', queued: 0, code: null,
      role: id === ORCH ? 'orch' : this.mode === 'orch' ? 'worker' : 'agent',
    }]));
  }

  snap(a) { return { ...a, tasks: a.tasks.map(t => ({ ...t })), connected: [...a.connected] }; }

  state() {
    return {
      agents: Object.values(this.agents).map(a => this.snap(a)), mode: this.mode, workspace: this.workspace || '', cfg: {}, demo: true,
      chats: [], feeds: Object.fromEntries(ALL.map(id => [id, []])),
    };
  }

  start() {
    this.stop();
    this.reset();
    this.emit('reset', this.state());
    for (const id of IDS) this.later(() => this.newJob(id), rand(300, 4000));
    this.every(() => this.chatter(), 9000);
    if (this.mode === 'orch') {
      this.later(() => this.orchJob(), 200);
      this.every(() => this.spoke(), 2600);
      this.every(() => this.maybeLink('message'), 11000);
      this.every(() => this.dispute(), 17000);
    } else this.every(() => this.maybeLink('request'), 7000);
  }

  stop() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
  }

  setMode(mode) {
    this.mode = mode === 'focus' ? 'orch' : mode;
    this.start();
  }

  later(fn, ms) { this.timers.push(setTimeout(fn, ms)); }
  every(fn, ms) { this.timers.push(setInterval(fn, ms)); }
  push(a) { this.emit('agent', this.snap(a)); }
  say(m) { this.emit('chat', { seq: ++this.seq, t: Date.now(), from: null, ...m }); }
  link(x, y, active) { const [a, b] = sorted(x, y); this.emit('link', { a, b, active }); }

  newJob(id) {
    const a = this.agents[id];
    const n = 3 + Math.floor(Math.random() * 4);
    a.tasks = Array.from({ length: n }, () => ({ text: pick(TASKS), status: 'pending' }));
    a.busy = true;
    a.status = 'WORKING';
    const brief = a.tasks.map(t => t.text.toLowerCase()).join(', ') + '.';
    if (this.mode === 'orch') {
      this.say({ id, role: 'peer', kind: 'assign', from: ORCH, text: `Fresh session. You own src/${pick(['api', 'db', 'util', 'components', 'reports'])}/. Task: ${brief}` });
      this.flash(id, 2500);
    } else this.say({ id, role: 'user', text: 'Demo instruction: ' + brief });
    this.step(id, 0);
  }

  step(id, i) {
    const a = this.agents[id];
    if (i >= a.tasks.length) {
      a.busy = false;
      a.status = 'STANDBY';
      this.push(a);
      this.emit('turn', { id });
      if (this.mode === 'orch') {
        this.say({ id: ORCH, role: 'peer', kind: 'report', from: id, text: `Done: ${a.tasks.length} tasks. Changed files listed; no contract changes.` });
        this.flash(id, 2000);
      } else this.say({ id, role: 'agent', text: `All ${a.tasks.length} tasks complete.` });
      this.later(() => this.newJob(id), rand(4000, 9000));
      return;
    }
    a.tasks[i].status = 'in_progress';
    this.push(a);
    const dur = rand(5000, 14000);
    const ticks = Math.floor(dur / 1100);
    for (let k = 0; k < ticks; k++) {
      this.later(() => {
        const [kind, text] = pick(FEED);
        this.emit('feed', { id, kind, text, t: Date.now() });
        if (kind === 'code') {
          const nl = text.indexOf('\n');
          a.code = { file: text.slice(0, nl).replace(/^(WRITE|EDIT)\s+/, ''), text: text.slice(nl + 1), t: Date.now() };
        }
        const add = Math.floor(rand(400, 3500));
        a.used += add;
        a.ctx = Math.min(150000, a.ctx + add * 1.4);
        a.watch = a.ctx > 84000 ? 'CONTEXT HIGH' : 'NOMINAL';
        if (a.ctx >= 120000) {
          a.watch = 'COMPACTING CONTEXT';
          this.emit('feed', { id, kind: 'sys', text: '-- watchdog: compacting context --', t: Date.now() });
          a.ctx = 18000;
        }
        this.push(a);
      }, k * 1100 + rand(0, 600));
    }
    this.later(() => {
      a.tasks[i].status = 'completed';
      this.push(a);
      this.step(id, i + 1);
    }, dur);
  }

  // The orchestrator plans, assigns, reviews and rules; it never writes code.
  orchJob() {
    const o = this.agents[ORCH];
    o.tasks = ORCH_TASKS.map(text => ({ text, status: 'pending' }));
    o.busy = true;
    o.status = 'WORKING';
    this.say({ id: ORCH, role: 'user', text: 'Demo instruction: rebuild the orders pipeline end to end, with tests.' });
    const run = i => {
      if (i >= o.tasks.length) {
        o.busy = false; o.status = 'STANDBY'; this.push(o);
        this.say({ id: ORCH, role: 'agent', text: 'Integration check passed. Ledger updated; all six reports merged.' });
        this.later(() => this.orchJob(), rand(6000, 10000));
        return;
      }
      o.tasks[i].status = 'in_progress';
      this.push(o);
      this.emit('feed', { id: ORCH, kind: pick(['io', 'net', 'run']), text: pick(['READ CLUSTER LEDGER.md', '>> ASSIGN {"agent":"C3","owns":["src/db/"]}', '>> LEDGER_WRITE {"section":"Contracts"}', '$ npm test', 'GREP "export"  in src/']), t: Date.now() });
      const add = Math.floor(rand(300, 1800));
      o.used += add; o.ctx = Math.min(80000, o.ctx + add);
      this.later(() => { o.tasks[i].status = 'completed'; this.push(o); run(i + 1); }, rand(4000, 8000));
    };
    run(0);
  }

  flash(id, ms) {
    this.link(id, ORCH, true);
    this.later(() => this.link(id, ORCH, false), ms);
  }

  spoke() {
    const id = pick(IDS);
    this.emit('feed', { id, kind: 'net', text: `>> ${pick(['READ_MESSAGES {}', 'UPDATE_TASK {"index":2,"status":"completed"}', 'CLUSTER_STATUS {}'])}`, t: Date.now() });
    this.flash(id, rand(1200, 3000));
  }

  dispute() {
    const [x, y] = IDS.slice().sort(() => Math.random() - 0.5);
    this.say({ id: ORCH, role: 'peer', kind: 'escalate', from: x, text: `${y} wants to rename the order total field; it breaks my endpoint. Please rule.` });
    this.flash(x, 4000);
    this.later(() => {
      this.say({ id: x, role: 'peer', kind: 'ruling', from: ORCH, text: `Keep "total". ${y} adds an alias instead. Recorded in the ledger.` });
      this.flash(y, 2500);
    }, 3000);
  }

  maybeLink(kind) {
    const [x, y] = IDS.slice().sort(() => Math.random() - 0.5);
    const A = this.agents[x], B = this.agents[y];
    if (A.connected.length || B.connected.length) return;
    A.connected = [y]; B.connected = [x];
    if (kind === 'request') A.status = 'AWAITING ' + y;
    this.push(A); this.push(B);
    this.link(x, y, true);
    if (kind === 'message') this.say({ id: y, role: 'peer', kind: 'message', from: x, text: 'What shape does your function return? I am calling it from mine.' });
    this.emit('feed', { id: x, kind: 'net', text: kind === 'message' ? `>> MESSAGE_AGENT {"agent":"${y}","message":"…"}` : `>> ASK_AGENT {"agent":"${y}","request":"…"}`, t: Date.now() });
    this.later(() => {
      A.connected = []; B.connected = [];
      A.status = A.busy ? 'WORKING' : 'STANDBY';
      this.push(A); this.push(B);
      this.link(x, y, false);
    }, rand(5000, 10000));
  }

  chatter() {
    const id = pick(IDS);
    this.say({ id, role: 'agent', text: pick([
      'Schema mapped. Three tables touch orders; claiming src/db/ before editing.',
      'Tests green. Moving on to the next item.',
      'Found the slow query: missing index on customer_id. Adding it now.',
      'Asked a neighbour to take the README so I can stay on the endpoint.',
    ]) });
  }
}

module.exports = { Demo };
