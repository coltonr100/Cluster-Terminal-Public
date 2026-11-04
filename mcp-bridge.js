'use strict';
// Tiny MCP server (stdio) that gives each agent its cluster tools.
// Every call is forwarded to the hub inside the Cluster Terminal app.

const http = require('http');

const AGENTS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];
const TOOLS = [
  {
    name: 'set_tasks',
    description: 'Post your task list for the current instruction (drives your progress meter). Replaces any previous list.',
    inputSchema: { type: 'object', properties: { tasks: { type: 'array', items: { type: 'string' }, description: 'Short task descriptions, in order.' } }, required: ['tasks'] },
  },
  {
    name: 'update_task',
    description: 'Mark a task from your list as in_progress or completed. index is 1-based.',
    inputSchema: { type: 'object', properties: { index: { type: 'integer' }, status: { type: 'string', enum: ['in_progress', 'completed'] } }, required: ['index', 'status'] },
  },
  {
    name: 'ask_agent',
    description: 'Ask another cluster agent to do a piece of work. Blocks until it replies, then returns its report. One helper at a time unless the operator allowed more.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: AGENTS },
        request: { type: 'string', description: 'Self-contained request: goal, file paths, what to report back.' },
        allow_extra: { type: 'boolean', description: 'Only true if the operator explicitly allowed more than one helper.' },
      },
      required: ['agent', 'request'],
    },
  },
  // ---- orch mode: orchestrator ----
  {
    name: 'assign',
    description: 'Hand pieces of work to workers. Returns at once; each worker\'s REPORT comes back to you later as a new message. A worker keeps its memory for follow-on work in files it worked on; otherwise it starts fresh, so the briefing (task + context) must be self-contained. owns = the files, folders or globs (relative to the project) that only this worker may edit; it replaces the worker\'s previous ownership.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              agent: { type: 'string', enum: AGENTS },
              task: { type: 'string', description: 'What to do and how to verify it.' },
              owns: { type: 'array', items: { type: 'string' }, description: 'Files/folders/globs this worker owns.' },
              context: { type: 'string', description: 'Contracts it must meet, relevant decisions, neighbours and what they own.' },
              name: { type: 'string', description: 'Optional short name (e.g. "setup"), so queued items can wait for it with after.' },
              model: { type: 'string', description: 'Optional model for this worker (e.g. "sonnet" for simple pages or docs). Default: the cluster\'s model.' },
              fresh: { type: 'boolean', description: 'Default: the worker keeps its memory if the work is in files it worked on (and its memory isn\'t large), else starts fresh. true: always fresh. false: always continue its last session.' },
              provides: { type: 'array', items: { type: 'string' }, description: 'Interfaces or artifacts it produces that others build on.' },
              done_when: { type: 'string', description: 'The piece\'s spec checklist: concrete rules and spec examples it must meet, with section names.' },
              priority: { type: 'string', enum: ['critical', 'normal', 'filler'] },
            },
            required: ['agent', 'task', 'owns'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'rule',
    description: 'Answer an open ticket. The paused worker resumes with your decision; other agents named on the ticket are told; the decision is recorded in the ledger.',
    inputSchema: {
      type: 'object',
      properties: {
        ticket: { type: 'integer' },
        decision: { type: 'string', description: 'The decision and a one-line reason.' },
        grant_files: { type: 'array', items: { type: 'string' }, description: 'Optional: give these files to the worker who asked.' },
      },
      required: ['ticket', 'decision'],
    },
  },
  {
    name: 'handoff',
    description: 'Move part of a BUSY worker\'s piece to a FREE worker, so they finish in parallel. Use it when a report shows someone free while another worker still has separable work inside files it owns. Safe by design: the receiver is reserved, the giver is told and hands the files over only at a working state (or refuses with a reason); then ownership and edit locks move together and the receiver starts with the giver\'s notes. Returns at once; the outcome comes as [HANDOFF #n DONE / REFUSED / TIMED OUT].',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', enum: AGENTS, description: 'The busy worker giving up the work.' },
        to: { type: 'string', enum: AGENTS, description: 'A free worker (see the load board).' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files, folders or globs, all owned by the giver, that move to the receiver (they may not exist yet).' },
        task: { type: 'string', description: 'What the receiver does and how to verify it.' },
        context: { type: 'string', description: 'Contracts, decisions and neighbours the receiver needs (it starts with a fresh memory).' },
      },
      required: ['from', 'to', 'files', 'task'],
    },
  },
  {
    name: 'stop',
    description: 'Halt workers instantly: kills their Claude Code processes mid-step (no report), drops their running assignments (queue items become "stopped" and do not restart), frees their files and leaves them idle for fresh work. Use it the moment the operator says stop; messages only reach workers between steps. Default: every worker, queue cleared; stopping every worker also turns off the integration check.',
    inputSchema: {
      type: 'object',
      properties: {
        agents: { type: 'array', items: { type: 'string', enum: AGENTS }, description: 'Workers to stop. Default: all of C1–C6.' },
        clear_queue: { type: 'boolean', description: 'Default true: remove every unfinished queue item. false: keep the queue (stopped items stay stopped; re-queue by name).' },
      },
    },
  },
  {
    name: 'queue_work',
    description: 'Line up work as short task cards. Free workers start ready items on their own (task + context are the briefing, plus the reports of the items it waits for), without waiting for your turn; reports still come to you. An item is ready when every item named in its after list has reported done and its files don\'t clash with a busy worker. Ready items start critical first, then by how much waits behind them; the worker whose area it is (built a prerequisite, or worked on its files) is preferred and keeps its memory. The reply includes a plan check (loops, shared files, bottlenecks, separate test/verify/audit items). team_size caps how many workers run at once: the number of pieces that are each ~5+ minutes of work and can run in parallel (usually 2–3 for a ~2,000-line project); idle workers cost nothing. Re-queue a finished item by adding it again under the same name.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Short unique name, e.g. "orders-api".' },
              task: { type: 'string', description: 'What to do and how to verify it.' },
              owns: { type: 'array', items: { type: 'string' }, description: 'Files/folders/globs this item owns.' },
              context: { type: 'string', description: 'Contracts, decisions, neighbours (the worker may start with a fresh memory).' },
              after: { type: 'array', items: { type: 'string' }, description: 'Names of items (queued or assigned with a name) that must finish first.' },
              model: { type: 'string', description: 'Optional model for this item, e.g. "sonnet".' },
              provides: { type: 'array', items: { type: 'string' }, description: 'Interfaces or artifacts it produces that others build on (e.g. "POST /api/orders", "db/schema.ts types").' },
              done_when: { type: 'string', description: 'The piece\'s spec checklist, checked by its builder before reporting: concrete rules and spec examples with section names, e.g. "§3 examples pass; GET /api/orders returns seeded rows; own tests pass".' },
              est_minutes: { type: 'number', description: 'Your estimate of how long this item takes one worker, in minutes (default 5). The hub adds up the estimates along each chain of waiting items to find the critical path: the longest chain starts first, is marked critical and gets an early split request when it is 6+ minutes.' },
              priority: { type: 'string', enum: ['critical', 'normal', 'filler'], description: 'critical: others wait on it, starts first. filler: side work, starts last.' },
              review: { type: 'boolean', description: 'true: a light, report-only spot check of a finished piece against the spec (owns nothing, edits nothing, a few minutes, sends gaps to owners). At most one per run; put the piece it checks in after.' },
            },
            required: ['name', 'task', 'owns'],
          },
        },
        remove: { type: 'array', items: { type: 'string' }, description: 'Names of queued items to drop.' },
        team_size: { type: 'integer', description: 'Most workers running at once (1–6).' },
        integration_check: { type: 'string', description: 'The project\'s full build + test command (Bash syntax, run in the project folder). The hub runs it every ~10 min while reports come in and when the queue empties, and tells you only about failures. Empty string turns it off.' },
      },
    },
  },
  {
    name: 'ledger_read',
    description: 'Read the project ledger (your long-term memory, also saved as .cluster/ledger.md).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ledger_write',
    description: 'Write one ledger section (Goal, Plan, Contracts, Decisions, Open questions, or your own). Empty text deletes the section. Keep it short: outcomes and pointers, not code.',
    inputSchema: {
      type: 'object',
      properties: { section: { type: 'string' }, text: { type: 'string' }, mode: { type: 'string', enum: ['replace', 'append'] } },
      required: ['section', 'text'],
    },
  },
  {
    name: 'set_ownership',
    description: 'Change which files a worker owns without assigning work (replace, add or remove).',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', enum: AGENTS }, paths: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['replace', 'add', 'remove'] } },
      required: ['agent', 'paths'],
    },
  },
  {
    name: 'comms_log',
    description: 'Recent traffic between agents: assignments, messages, tickets, rulings, reports.',
    inputSchema: { type: 'object', properties: { last: { type: 'integer', description: 'How many entries (default 30).' } } },
  },
  // ---- orch mode: workers (message_agent is for the orchestrator too) ----
  {
    name: 'message_agent',
    description: 'Send a short message to another worker or to ORCH. Does not wait. Working agents read messages between steps.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', enum: [...AGENTS, 'ORCH', 'ALL'], description: 'ALL: every worker that is working (for one-line heads-ups like "my interface is ready").' }, message: { type: 'string' } },
      required: ['agent', 'message'],
    },
  },
  {
    name: 'read_messages',
    description: 'Read messages other agents sent you. wait_seconds (0–20) waits for one to arrive first; refused while you still have unstarted tasks (work on those instead).',
    inputSchema: { type: 'object', properties: { wait_seconds: { type: 'integer' } } },
  },
  {
    name: 'escalate',
    description: 'Ask the orchestrator to decide, and wait for the ruling: a dispute with another worker, a change to a shared contract, files you need that someone else owns, or a blocking question.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['dispute', 'change', 'files', 'question'] },
        summary: { type: 'string', description: 'What needs deciding, the options, and your recommendation.' },
        agents: { type: 'array', items: { type: 'string', enum: AGENTS }, description: 'Other workers involved.' },
        files: { type: 'array', items: { type: 'string' } },
      },
      required: ['kind', 'summary'],
    },
  },
  {
    name: 'hand_over',
    description: 'Answer a [HANDOFF #n FROM ORCH]: first bring the named files to a working state and stop editing them, then call this. The files become the receiver\'s; your notes go into its briefing. refuse=true (with a reason) keeps them with you.',
    inputSchema: {
      type: 'object',
      properties: {
        handoff: { type: 'integer' },
        notes: { type: 'string', description: 'For the receiver: what is done, what is half-done, anything it must know. With refuse=true: why.' },
        refuse: { type: 'boolean' },
      },
      required: ['handoff', 'notes'],
    },
  },
  {
    name: 'propose_work',
    description: 'Put work you discovered outside your own piece on the queue (a missing module, a helper several pieces need). Not for tests or checks of another worker\'s piece: message its owner instead. A free worker starts it on its own; ORCH is told and may remove it. Its files must not belong to another working worker. Don\'t build it yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Short unique name.' },
              task: { type: 'string', description: 'What to do and how to verify it (2–4 lines).' },
              owns: { type: 'array', items: { type: 'string' }, description: 'Files/folders/globs it owns.' },
              context: { type: 'string', description: 'Interfaces it must meet and where they are (the worker starts with a fresh memory).' },
              after: { type: 'array', items: { type: 'string' }, description: 'Queue items that must be ready first.' },
              provides: { type: 'array', items: { type: 'string' } },
              done_when: { type: 'string' },
              priority: { type: 'string', enum: ['critical', 'normal', 'filler'] },
            },
            required: ['name', 'task', 'owns'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'offer_split',
    description: 'Split off part of your own piece so a free worker builds it in parallel (answer to a [SPLIT REQUEST FROM THE HUB], or on your own when your piece is bigger than expected). First bring those files to a working state. They leave your ownership at once and start on a free worker (or the next one). none=true: nothing is separable right now.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Files/folders/globs you own that move to the helper (they may not exist yet).' },
        task: { type: 'string', description: 'What the helper builds and how to verify it.' },
        notes: { type: 'string', description: 'What is done, the interfaces it must meet and where they are, anything it must know.' },
        done_when: { type: 'string' },
        provides: { type: 'array', items: { type: 'string' } },
        none: { type: 'boolean', description: 'true: nothing is separable right now (put the reason in notes).' },
      },
    },
  },
  {
    name: 'mark_ready',
    description: 'Say your public interface is final (exports compile, endpoint answers). Every working worker hears it, and queued work that waits on your piece starts now instead of after your report. Keep the interface stable afterwards.',
    inputSchema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'The exports/endpoints others use and the files they are in, plus one example call and its result, in a few lines.' } },
      required: ['summary'],
    },
  },
  {
    name: 'claim_files',
    description: 'Reserve files so other agents cannot edit them during your turn.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] },
  },
  {
    name: 'release_files',
    description: 'Release files you claimed.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] },
  },
  {
    name: 'check',
    description: 'Shared checks, so agents don\'t all compile and test at once. kind "types": latest errors from a shared TypeScript watcher for a folder (seconds; needs tsconfig.json and typescript installed there). kind "run": runs command (tests, a build) in a shared queue, in folder, with your PORT set, and returns the exit code and output tail.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['types', 'run'] },
        folder: { type: 'string', description: 'Folder inside the project, relative to it (e.g. "gatehouse"). Default: the project folder.' },
        files: { type: 'array', items: { type: 'string' }, description: 'types: only show errors in these files (relative to folder). The total is always given.' },
        command: { type: 'string', description: 'run: the command, in Bash syntax (e.g. "npx vitest run tests/holds.test.ts").' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'cluster_status',
    description: 'Show every agent\'s status and task progress, plus claimed files.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function rpc(method, params) {
  return new Promise(resolve => {
    const body = JSON.stringify({ token: process.env.CT_TOKEN, agent: process.env.CT_AGENT, method, params });
    const req = http.request({ host: '127.0.0.1', port: +process.env.CT_PORT, path: '/rpc', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ error: 'bad hub reply' }); } });
    });
    req.on('error', e => resolve({ error: 'Cluster hub unreachable: ' + e.message }));
    req.end(body);
  });
}

// Each role sees only its own tools.
const ROLE_TOOLS = {
  agent: ['set_tasks', 'update_task', 'ask_agent', 'claim_files', 'release_files', 'check', 'cluster_status'],
  worker: ['set_tasks', 'update_task', 'message_agent', 'read_messages', 'escalate', 'hand_over', 'propose_work', 'offer_split', 'mark_ready', 'claim_files', 'release_files', 'check', 'cluster_status'],
  orch: ['set_tasks', 'update_task', 'assign', 'queue_work', 'stop', 'handoff', 'rule', 'ledger_read', 'ledger_write', 'set_ownership', 'message_agent', 'comms_log', 'check', 'cluster_status'],
};
const role = process.env.CT_MODE !== 'orch' ? 'agent' : process.env.CT_AGENT === 'ORCH' ? 'orch' : 'worker';
const MY_TOOLS = TOOLS.filter(t => ROLE_TOOLS[role].includes(t.name));

const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  if (method === 'initialize') {
    return send({ id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cluster', version: '0.1.0' } } });
  }
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools: MY_TOOLS } });
  if (method === 'tools/call') {
    const args = { ...(params?.arguments || {}), cwd: process.cwd() };
    const r = await rpc(params?.name, args);
    return send({ id, result: { content: [{ type: 'text', text: r.error || r.text || '' }], isError: !!r.error } });
  }
  send({ id, error: { code: -32601, message: 'Method not found' } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch {}
  }
});
