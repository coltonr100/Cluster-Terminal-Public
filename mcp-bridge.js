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
  {
    name: 'dispatch',
    description: 'Focus mode, lead (C1) only: send one task each to several agents at once. Blocks until all reply and returns their reports.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: { type: 'object', properties: { agent: { type: 'string', enum: AGENTS.slice(1) }, task: { type: 'string' } }, required: ['agent', 'task'] },
        },
      },
      required: ['tasks'],
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

const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  if (method === 'initialize') {
    return send({ id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cluster', version: '0.1.0' } } });
  }
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools: TOOLS } });
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
