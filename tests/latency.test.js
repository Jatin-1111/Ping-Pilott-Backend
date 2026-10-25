// Run with: npm test
// The response time is the request that answered, on a fresh connection, measured with a monotonic clock.
// Before: the clock started before the address safety check, a HEAD that was turned away was added to the GET that
// worked, and pooled sockets let a check skip the TCP and TLS handshakes that the one before it had paid for.
//
// These tests run real sockets against a local server, so they switch off the private-address guard (as local
// development does). The guard has its own purpose and is not what is under test here.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { checkServerStatus } from '../services/monitoringService.js';

let server;
let port;
let connections = 0;
const requests = []; // { method, path }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
    process.env.ALLOW_PRIVATE_TARGETS = 'true';
    // Every answer carries a Content-Length: without one the server closes the connection itself, which would hide
    // whether the checker kept the socket open.
    const answer = (req, res, status) => {
        res.writeHead(status, { 'Content-Length': 2 });
        res.end(req.method === 'HEAD' ? undefined : 'ok');
    };
    server = http.createServer(async (req, res) => {
        requests.push({ method: req.method, path: req.url });

        if (req.url === '/delay-150') {
            await sleep(150);
            answer(req, res, 200);
        } else if (req.url === '/head-refused') {
            // This server answers HEAD slowly and wrongly, and GET quickly: only the GET should be timed
            if (req.method === 'HEAD') {
                await sleep(400);
                answer(req, res, 405);
            } else {
                await sleep(100);
                answer(req, res, 200);
            }
        } else {
            answer(req, res, 200);
        }
    });
    server.on('connection', () => { connections += 1; });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
});

after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
});

const url = (path = '/') => `http://127.0.0.1:${port}${path}`;
const serverDoc = (path, extra = {}) => ({ url: url(path), type: 'website', monitoring: { alerts: { responseThreshold: 1000 } }, ...extra });

test('the response time is the time the server took to answer', async () => {
    const result = await checkServerStatus(serverDoc('/delay-150'));
    assert.equal(result.status, 'up');
    assert.ok(result.responseTime >= 140, `took the 150 ms the server waited, got ${result.responseTime}`);
    assert.ok(result.responseTime < 1000, `and little more, got ${result.responseTime}`);
    assert.equal(result.slow, false);
});

test('a HEAD that was turned away is not added to the GET that answered', async () => {
    requests.length = 0;
    const result = await checkServerStatus(serverDoc('/head-refused'));

    assert.equal(result.status, 'up');
    assert.deepEqual(requests.map((r) => r.method), ['HEAD', 'GET'], 'it did fall back to GET');
    // The HEAD took 400 ms. Counting it would put this over 500 ms.
    assert.ok(result.responseTime >= 90, `the GET took 100 ms, got ${result.responseTime}`);
    assert.ok(result.responseTime < 350, `the failed HEAD is left out, got ${result.responseTime}`);
});

test('every check uses its own connection, so none skips the handshakes of another', async () => {
    connections = 0;
    // A pause lets a pooled socket go back to its pool, so a checker that pools would reuse it and count 1 here
    for (let i = 0; i < 3; i++) {
        await checkServerStatus(serverDoc('/'));
        await sleep(50);
    }
    assert.equal(connections, 3);
});

test('slow is decided against the threshold on the same number that is reported', async () => {
    const slow = await checkServerStatus(serverDoc('/delay-150', { monitoring: { alerts: { responseThreshold: 100 } } }));
    assert.equal(slow.status, 'up');
    assert.equal(slow.slow, true);
    assert.match(slow.error, /Slow response: \d+ms exceeds threshold of 100ms/);

    const fine = await checkServerStatus(serverDoc('/delay-150', { monitoring: { alerts: { responseThreshold: 1000 } } }));
    assert.equal(fine.slow, false);
    assert.equal(fine.error, null);
});

test('a response time is never 0, which the feed and charts read as "no data"', async () => {
    const result = await checkServerStatus(serverDoc('/'));
    assert.ok(result.responseTime >= 1);
});

test('a TCP check reports how long the connection took, and a refused one is down with no time', async () => {
    const tcp = net.createServer((socket) => socket.end());
    await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    const tcpPort = tcp.address().port;

    const up = await checkServerStatus({ url: `127.0.0.1:${tcpPort}`, type: 'tcp', monitoring: {} });
    assert.equal(up.status, 'up');
    assert.ok(up.responseTime >= 1 && up.responseTime < 1000);

    await new Promise((resolve) => tcp.close(resolve));
    const refused = await checkServerStatus({ url: `127.0.0.1:${tcpPort}`, type: 'tcp', monitoring: {} });
    assert.equal(refused.status, 'down');
    assert.equal(refused.responseTime, null);
    assert.equal(refused.error, 'Connection refused');
});
