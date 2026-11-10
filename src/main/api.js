// Loopback-only HTTP API used by the MCP server. A random port and bearer token
// are written to api.json in the app's data folder on every start.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { agent } = require('./tools');

function start(dataDir, version) {
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      // Browsers always send Origin on cross-site POSTs; agents never do.
      if (req.headers.origin) return send(403, { error: 'Browser requests are not allowed' });
      const given = Buffer.from(String(req.headers.authorization || ''));
      const want = Buffer.from('Bearer ' + token);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(401, { error: 'Bad token' });
      const m = req.url.match(/^\/tool\/([a-z_]+)$/);
      if (req.method !== 'POST' || !m) return send(404, { error: 'Not found' });
      const fn = Object.hasOwn(agent, m[1]) ? agent[m[1]] : null;
      if (!fn) return send(404, { error: 'Unknown tool ' + m[1] });
      let raw = '';
      for await (const c of req) { raw += c; if (raw.length > 4e6) return send(413, { error: 'Request too large' }); }
      const args = raw ? JSON.parse(raw) : {};
      send(200, { result: await fn(args) });
    } catch (e) {
      send(500, { error: e.message || String(e) });
    }
  });
  server.listen(0, '127.0.0.1', () => {
    const info = { port: server.address().port, token, pid: process.pid, version };
    fs.writeFileSync(path.join(dataDir, 'api.json'), JSON.stringify(info), { mode: 0o600 });
  });
  return server;
}

module.exports = { start };
