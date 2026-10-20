// Tiny admin HTTP API: POST /<command> with JSON body, Bearer token auth.
import http from 'node:http';
import { config } from '../config.js';
import { logger } from '../log.js';

const log = logger('admin-http');

export function startAdminServer(commands, { port = config.admin.port, token = config.admin.token } = {}) {
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 1)); };
    if (req.url === '/health') return send(200, { ok: true });
    const auth = req.headers.authorization || '';
    if (!token || auth !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
    const name = (req.url || '/').split('?')[0].replace(/^\//, '');
    const fn = commands[name];
    if (!fn || name === 'constructor') return send(404, { error: `unknown command ${name}` });
    let body = '';
    for await (const chunk of req) body += chunk;
    let args = {};
    try { args = body ? JSON.parse(body) : {}; } catch { return send(400, { error: 'invalid json' }); }
    try { send(200, await fn(args)); }
    catch (e) { log.warn(`${name} failed: ${e.message}`); send(400, { error: e.message }); }
  });
  server.listen(port, '0.0.0.0', () => log.info(`admin api on :${port}`));
  return server;
}
