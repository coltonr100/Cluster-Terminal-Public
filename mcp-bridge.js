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
    description: 'Hand pieces of work to workers. Returns at once; each worker\'s REPORT comes back to you later as a new message. Each worker starts with a fresh memory, so the briefing (task + context) must be self-contained. owns = the files, folders or globs (relative to the project) that only this worker may edit; it replaces the worker\'s previous ownership.',
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
              fresh: { type: 'boolean', description: 'Default true: new session. false: continue the worker\'s last session (for a quick follow-up fix).' },
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
      properties: { agent: { type: 'string', enum: [...AGENTS, 'ORCH'] }, message: { type: 'string' } },
      required: ['agent', 'message'],
    },
  },
  {
    name: 'read_messages',
    description: 'Read messages other agents sent you. wait_seconds (0–180) waits for one to arrive first.',
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
  agent: ['set_tasks', 'update_task', 'ask_agent', 'claim_files', 'release_files', 'cluster_status'],
  worker: ['set_tasks', 'update_task', 'message_agent', 'read_messages', 'escalate', 'claim_files', 'release_files', 'cluster_status'],
  orch: ['set_tasks', 'update_task', 'assign', 'rule', 'ledger_read', 'ledger_write', 'set_ownership', 'message_agent', 'comms_log', 'cluster_status'],
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
