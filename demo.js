'use strict';
// Demo mode: fake agents that send the same events as the real cluster, so the
// screen can be shown off without using any Claude usage.

const { EventEmitter } = require('events');
const { IDS } = require('./orchestrator');

const TASKS = [
  'Map the existing schema', 'Write migration for orders table', 'Add index on customer_id', 'Build REST endpoint /api/orders',
  'Wire up input validation', 'Write unit tests for parser', 'Refactor auth middleware', 'Profile slow query', 'Update README',
  'Add retry logic to fetcher', 'Render chart component', 'Fix timezone bug in reports', 'Seed test database', 'Lint and format',
];

const FEED = [
  ['sql', 'SELECT c.id, c.region, SUM(o.total) AS revenue\nFROM customers c\nJOIN orders o ON o.customer_id = c.id\nWHERE o.created_at >= DATE(\'now\', \'-30 day\')\nGROUP BY c.id, c.region\nORDER BY revenue DESC\nLIMIT 25;'],
  ['sql', 'CREATE INDEX IF NOT EXISTS idx_orders_customer\n  ON orders (customer_id, created_at);'],
  ['sql', 'UPDATE refinement_bins SET status = \'complete\'\nWHERE file_id = 4471 AND quota_met = 1;'],
  ['run', '$ npm test -- --runInBand'],
  ['out', 'PASS  src/parser.test.js (24 tests)\nPASS  src/orders.test.js (11 tests)'],
  ['run', '$ python -m pytest tests/ -q'],
  ['out', '.................................. 34 passed in 2.81s'],
  ['code', 'EDIT src/api/orders.js\nrouter.get(\'/orders/:id\', async (req, res) => {\n  const order = await db.orders.find(req.params.id);\n  if (!order) return res.status(404).json({ error: \'not found\' });\n  res.json(order);\n});'],
  ['code', 'WRITE src/util/retry.js\nexport async function retry(fn, tries = 3, wait = 250) {\n  for (let i = 0; i < tries; i++) {\n    try { return await fn(); }\n    catch (e) { if (i === tries - 1) throw e; await sleep(wait * 2 ** i); }\n  }\n}'],
  ['code', 'EDIT reports/tz.py\ndef to_central(ts):\n    return ts.astimezone(ZoneInfo("America/Chicago"))'],
  ['io', 'READ src/db/schema.sql'],
  ['io', 'GREP "customer_id"  in src/'],
  ['run', 'PS> Get-ChildItem -Recurse -Filter *.sql | Measure-Object'],
  ['net', '>> UPDATE_TASK {"index":2,"status":"completed"}'],
  ['run', '$ git diff --stat'],
  ['out', ' src/api/orders.js | 18 ++++++++++++------\n 1 file changed, 12 insertions(+), 6 deletions(-)'],
];

const pick = a => a[Math.floor(Math.random() * a.length)];
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

class Demo extends EventEmitter {
  constructor() {
    super();
    this.timers = [];
    this.mode = 'individual';
    this.seq = 0;
    this.reset();
  }

  reset() {
    this.agents = Object.fromEntries(IDS.map(id => [id, {
      id, status: 'IDLE', busy: false, tasks: [], ctx: 0, used: 0, connected: [], watch: 'NOMINAL', queued: 0,
    }]));
  }

  state() {
    return { agents: Object.values(this.agents), mode: this.mode, focusLit: this.mode === 'focus', workspace: this.workspace || '', cfg: {}, demo: true };
  }

  start() {
    this.stop();
    this.reset();
    this.emit('reset', this.state());
    for (const id of IDS) this.later(() => this.newJob(id), rand(300, 4000));
    this.every(() => this.chatter(), 9000);
    if (this.mode === 'individual') this.every(() => this.maybeLink(), 7000);
  }

  stop() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
  }

  setMode(mode) {
    this.mode = mode;
    this.start();
    if (mode === 'focus') this.emit('focus', { on: true });
  }

  later(fn, ms) { this.timers.push(setTimeout(fn, ms)); }
  every(fn, ms) { this.timers.push(setInterval(fn, ms)); }
  push(a) { this.emit('agent', { ...a, tasks: a.tasks.map(t => ({ ...t })), connected: [...a.connected] }); }

  newJob(id) {
    const a = this.agents[id];
    const n = 3 + Math.floor(Math.random() * 4);
    a.tasks = Array.from({ length: n }, () => ({ text: pick(TASKS), status: 'pending' }));
    a.busy = true;
    a.status = 'WORKING';
    this.emit('chat', { id, role: 'user', text: 'Demo instruction: ' + a.tasks.map(t => t.text.toLowerCase()).join(', ') + '.', seq: ++this.seq, t: Date.now() });
    this.step(id, 0);
  }

  step(id, i) {
    const a = this.agents[id];
    if (i >= a.tasks.length) {
      a.busy = false;
      a.status = 'STANDBY';
      this.push(a);
      this.emit('turn', { id });
      this.emit('chat', { id, role: 'agent', text: `All ${a.tasks.length} tasks complete.`, seq: ++this.seq, t: Date.now() });
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

  maybeLink() {
    const [x, y] = IDS.slice().sort(() => Math.random() - 0.5);
    const A = this.agents[x], B = this.agents[y];
    if (A.connected.length || B.connected.length) return;
    A.connected = [y]; B.connected = [x];
    A.status = 'AWAITING ' + y;
    this.push(A); this.push(B);
    this.emit('link', { a: [x, y].sort()[0], b: [x, y].sort()[1], active: true });
    this.emit('feed', { id: x, kind: 'net', text: `>> ASK_AGENT {"agent":"${y}","request":"…"}`, t: Date.now() });
    this.later(() => {
      A.connected = []; B.connected = [];
      A.status = A.busy ? 'WORKING' : 'STANDBY';
      this.push(A); this.push(B);
      this.emit('link', { a: [x, y].sort()[0], b: [x, y].sort()[1], active: false });
    }, rand(5000, 10000));
  }

  chatter() {
    const id = pick(IDS);
    this.emit('chat', { id, role: 'agent', text: pick([
      'Schema mapped. Three tables touch orders; claiming src/db/ before editing.',
      'Tests green. Moving on to the next item.',
      'Found the slow query: missing index on customer_id. Adding it now.',
      'Asked a neighbour to take the README so I can stay on the endpoint.',
    ]), seq: ++this.seq, t: Date.now() });
  }
}

module.exports = { Demo };
