#!/usr/bin/env node
// CLI for the admin HTTP API:  npm run admin -- status | start | ff 120 | events 50 | ...
import { config } from '../src/config.js';
import { formatForChat, HELP } from '../src/admin/commands.js';

const [cmd, arg] = process.argv.slice(2);
if (!cmd || cmd === 'help') { console.log(HELP); process.exit(0); }
const args = cmd === 'ff' ? { minutes: arg } : cmd === 'events' ? { limit: arg } : {};
const res = await fetch(`${config.admin.url}/${cmd}`, {
  method: 'POST', headers: { authorization: `Bearer ${config.admin.token}`, 'content-type': 'application/json' }, body: JSON.stringify(args),
}).catch((e) => { console.error(`cannot reach ${config.admin.url}: ${e.message}`); process.exit(1); });
const body = await res.json();
if (!res.ok) { console.error(body.error || body); process.exit(1); }
console.log(process.argv.includes('--json') ? JSON.stringify(body, null, 2) : formatForChat(cmd, body));
