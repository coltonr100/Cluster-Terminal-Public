'use strict';
// PreToolUse hook: before an agent edits a file, ask the hub whether another
// agent holds it. Refuses the edit if so. If the app can't be reached, allows it.

const http = require('http');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  let ev;
  try { ev = JSON.parse(input); } catch { process.exit(0); }
  const ti = ev.tool_input || {};
  const file = ti.file_path || ti.notebook_path;
  const command = /^(Bash|PowerShell)$/.test(ev.tool_name || '') ? ti.command : null;
  if ((!file && !command) || !process.env.CT_PORT) process.exit(0);
  const body = JSON.stringify({ token: process.env.CT_TOKEN, agent: process.env.CT_AGENT, method: 'guard', params: { file, command, cwd: ev.cwd } });
  const req = http.request({ host: '127.0.0.1', port: +process.env.CT_PORT, path: '/rpc', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
    let data = '';
    res.on('data', d => { data += d; });
    res.on('end', () => {
      let r = {};
      try { r = JSON.parse(data); } catch {}
      if (r.allow === false) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.reason } }));
      }
      process.exit(0);
    });
  });
  req.on('error', () => process.exit(0));
  req.setTimeout(10000, () => process.exit(0));
  req.end(body);
});
