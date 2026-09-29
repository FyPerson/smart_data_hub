'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fetchTestHttp = require('./lib/test-http-fetch');
const { listenOnSafePort } = require('./lib/listen-safe-port');

async function run(request = fetchTestHttp) {
  let pass = 0;
  const check = (label, condition) => { assert.ok(condition, label); pass++; };
  let port = 0;
  // Rebind the very same origin, rather than hoping listen(0) recycles a port.
  for (let world = 0; world < 12; world++) {
    const sockets = new Set();
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits++;
      sockets.add(req.socket);
      if (req.url === '/disconnect') { req.socket.destroy(); return; }
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ world, method: req.method, body, connection: req.headers.connection, marker: req.headers['x-test-marker'] }));
      });
    });
    try {
      // #95: the first origin comes from the safe-port helper (never an OS-assigned port); later worlds rebind it.
      if (port === 0) await listenOnSafePort(server);
      else await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      port = server.address().port;
      for (let index = 0; index < 3; index++) {
        const values = { Connection: 'keep-alive', 'X-Test-Marker': `${world}-${index}` };
        const headers = index === 0 ? values : index === 1 ? new Headers(values) : Object.entries(values);
        const body = JSON.stringify({ world, index });
        const response = await request(`http://127.0.0.1:${port}/echo`, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
        const data = await response.json();
        check('HTTP error response/body/headers preserved', response.status === 409 && data.world === world && data.method === 'POST' && data.body === body && data.marker === values['X-Test-Marker']);
        check('request opts out of pooled connections', data.connection === 'close');
        check('caller headers not mutated', headers instanceof Headers ? headers.get('Connection') === 'keep-alive' : Array.isArray(headers) ? headers[0][1] === 'keep-alive' : headers.Connection === 'keep-alive');
      }
      check('each request uses its own socket', sockets.size === 3 && hits === 3);
      await assert.rejects(request(`http://127.0.0.1:${port}/disconnect`, { method: 'POST', body: 'never retry writes', signal: AbortSignal.timeout(5000) }), /fetch failed/);
      check('transport failure is not retried', hits === 4);
      await assert.rejects(request(`http://127.0.0.1:${port}/echo`, { signal: AbortSignal.abort() }), { name: 'AbortError' });
      check('caller cancellation is preserved', hits === 4);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
    }
  }
  console.log('HTTP_FIXTURE worlds=12 same_origin=true transport_retries=0');
  console.log(`PASS=${pass} FAIL=0`);
  return pass;
}

module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); console.log('PASS=0 FAIL=1'); process.exitCode = 1; });
