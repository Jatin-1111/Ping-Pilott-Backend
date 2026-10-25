// Run with: npm test
// Where a failed check stopped: the step that failed (failedPhase), the steps that finished before it with how long the
// one it stopped in had run (partial timings), and the address the name resolved to.
//
// The sockets are real and local, as in tests/phases.test.js; a name made up for the test fails to resolve after a delay.
// A check that has to time out is covered by the pure functions only: a real one would take the full 10 s.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import { checkServerStatus } from '../services/monitoringService.js';
import { stageOf, partialTimings } from '../utils/requestTiming.js';
import { failedPhaseOf, FAILED_PHASES } from '../utils/failurePhase.js';

const DNS_DELAY = 60;
const realLookup = dns.lookup;

let httpServer;
let httpPort;
let garbageServer;
let garbagePort;
let closedPort;

before(async () => {
    process.env.ALLOW_PRIVATE_TARGETS = 'true';

    dns.lookup = (hostname, options, callback) => {
        if (hostname === 'gone.test') {
            setTimeout(() => callback(Object.assign(new Error('getaddrinfo ENOTFOUND gone.test'), { code: 'ENOTFOUND', hostname })), DNS_DELAY);
        } else if (hostname === 'up.test') {
            setImmediate(() => callback(null, [{ address: '127.0.0.1', family: 4 }])); // a real resolver is never synchronous
        } else {
            realLookup(hostname, options, callback);
        }
    };

    httpServer = http.createServer((req, res) => {
        const status = Number(new URL(req.url, 'http://x').searchParams.get('status') || 200);
        res.writeHead(status, { 'Content-Length': 2 });
        res.end('ok');
    });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    httpPort = httpServer.address().port;

    // Accepts a connection and speaks something that is not TLS, so an https check fails inside the handshake
    garbageServer = net.createServer((socket) => socket.end('this is not a TLS server\r\n'));
    await new Promise((resolve) => garbageServer.listen(0, '127.0.0.1', resolve));
    garbagePort = garbageServer.address().port;

    // A port nothing is listening on
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    closedPort = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
});

after(async () => {
    dns.lookup = realLookup;
    for (const server of [httpServer, garbageServer]) {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
});

const site = (url, extra = {}) => ({ url, type: 'website', monitoring: {}, ...extra });

// ── failedPhaseOf: the mapping ──

test('each kind of failure names the step it belongs to', () => {
    const cases = [
        [{ kind: 'dns' }, 'dns'],
        [{ kind: 'refused' }, 'connect'],
        [{ kind: 'unreachable' }, 'connect'],
        [{ kind: 'tls' }, 'tls'],
        [{ kind: 'http', stage: undefined }, 'response'],
        [{ kind: 'no_response' }, 'response'],
        [{ kind: 'content' }, 'content']
    ];
    for (const [failure, phase] of cases) assert.equal(failedPhaseOf(failure), phase, JSON.stringify(failure));
});

test('a timeout is whichever step it was waiting in, and never "response", which is what no_response is', () => {
    assert.equal(failedPhaseOf({ kind: 'timeout', stage: 'dns' }), 'dns');
    assert.equal(failedPhaseOf({ kind: 'timeout', stage: 'connect' }), 'connect');
    assert.equal(failedPhaseOf({ kind: 'timeout', stage: 'tls' }), 'tls');
    assert.equal(failedPhaseOf({ kind: 'timeout', stage: 'response' }), 'connect');
    assert.equal(failedPhaseOf({ kind: 'timeout' }), 'connect');
});

test('a reset or an unclassified error is where the connection was, and says nothing when that is unknown', () => {
    assert.equal(failedPhaseOf({ kind: 'reset', stage: 'tls' }), 'tls');
    assert.equal(failedPhaseOf({ kind: 'reset' }), 'response');
    assert.equal(failedPhaseOf({ kind: 'other', stage: 'connect' }), 'connect');
    assert.equal(failedPhaseOf({ kind: 'other' }), null);
});

test('an address that was never checked, and no failure at all, have no failed step', () => {
    for (const failure of [{ kind: 'blocked' }, { kind: 'invalid' }, { kind: null }, {}, undefined, { kind: 'nonsense' }]) {
        assert.equal(failedPhaseOf(failure), null, JSON.stringify(failure));
    }
    for (const phase of FAILED_PHASES) assert.equal(typeof phase, 'string');
});

// ── the arithmetic of a failed hop ──

test('the stage is the step the connection was in', () => {
    assert.equal(stageOf(undefined), null);
    assert.equal(stageOf({ named: true, lookupAt: null }), 'dns');
    assert.equal(stageOf({ named: true, lookupAt: 5, lookupFailed: true }), 'dns');
    assert.equal(stageOf({ named: false, lookupAt: null, connectAt: null }), 'connect', 'an address has no lookup to wait for');
    assert.equal(stageOf({ named: true, lookupAt: 5, connectAt: null }), 'connect');
    assert.equal(stageOf({ named: true, lookupAt: 5, connectAt: 9, secure: true, secureAt: null }), 'tls');
    assert.equal(stageOf({ named: true, lookupAt: 5, connectAt: 9, secure: true, secureAt: 20 }), 'response');
    assert.equal(stageOf({ named: false, connectAt: 9, secure: false }), 'response');
});

test('partial timings hold the finished steps and the time the unfinished one had run', () => {
    // never resolved: 9800 ms in the lookup
    assert.deepEqual(partialTimings({ named: true, startedAt: 100, lookupAt: null }, 90, 9900), { redirects: 10, dns: 9800 });
    // resolved in 30, connecting for 9970
    assert.deepEqual(partialTimings({ named: true, startedAt: 100, lookupAt: 130, connectAt: null }, 100, 10100), { redirects: 0, dns: 30, connect: 9970 });
    // through connect, stuck in TLS for 700
    assert.deepEqual(partialTimings({ named: true, startedAt: 0, lookupAt: 20, connectAt: 60, secure: true, secureAt: null }, 0, 760), { redirects: 0, dns: 20, connect: 40, tls: 700 });
    // through TLS, waited 9000 for the answer
    assert.deepEqual(partialTimings({ named: true, startedAt: 0, lookupAt: 20, connectAt: 60, secure: true, secureAt: 160 }, 0, 9160), { redirects: 0, dns: 20, connect: 40, tls: 100, ttfb: 9000 });
    // plain HTTP: no TLS time
    assert.deepEqual(partialTimings({ named: false, startedAt: 0, lookupAt: null, connectAt: 5, secure: false }, 0, 105), { redirects: 0, dns: 0, connect: 5, tls: 0, ttfb: 100 });
    assert.equal(partialTimings(undefined, 0, 10), null);
});

// ── real sockets ──

test('a name that does not resolve fails in dns, with the time the lookup took and nothing after it', async () => {
    const result = await checkServerStatus(site(`http://gone.test:${httpPort}/`));
    assert.equal(result.status, 'down');
    assert.equal(result.failure.kind, 'dns');
    assert.equal(result.failedPhase, 'dns');
    assert.ok(result.timings.dns >= DNS_DELAY - 5, `dns ${result.timings.dns}`);
    assert.equal('connect' in result.timings, false, 'it never got to connecting');
    assert.equal(result.resolvedAddress, null);
    assert.equal(result.serverTime, null);
});

test('a refused connection fails in connect, after a lookup that worked', async () => {
    const result = await checkServerStatus(site(`http://up.test:${closedPort}/`));
    assert.equal(result.status, 'down');
    assert.equal(result.failure.kind, 'refused');
    assert.equal(result.failedPhase, 'connect');
    assert.ok(result.timings.dns >= 0 && 'connect' in result.timings);
    assert.equal('tls' in result.timings, false);
    assert.equal(result.resolvedAddress, '127.0.0.1');
});

test('an address has no lookup, so a refused one is a connect failure with dns 0', async () => {
    const result = await checkServerStatus(site(`http://127.0.0.1:${closedPort}/`));
    assert.equal(result.failedPhase, 'connect');
    assert.equal(result.timings.dns, 0);
});

test('a server that is not speaking TLS fails in tls, with the steps before it finished', async () => {
    const result = await checkServerStatus(site(`https://up.test:${garbagePort}/`));
    assert.equal(result.status, 'down');
    assert.equal(result.failure.kind, 'tls', result.error);
    assert.equal(result.failedPhase, 'tls');
    assert.ok('dns' in result.timings && 'connect' in result.timings && 'tls' in result.timings, JSON.stringify(result.timings));
    assert.equal('ttfb' in result.timings, false);
    assert.equal(result.resolvedAddress, '127.0.0.1');
});

test('a server that answers with an error fails in response, and keeps the timings and address of that answer', async () => {
    const result = await checkServerStatus(site(`http://127.0.0.1:${httpPort}/?status=502`));
    assert.equal(result.status, 'down');
    assert.equal(result.failure.kind, 'http');
    assert.equal(result.failedPhase, 'response');
    assert.deepEqual(Object.keys(result.timings).sort(), ['connect', 'dns', 'redirects', 'tls', 'ttfb']);
    assert.equal(result.resolvedAddress, null, 'an address was typed, so nothing was resolved');
    assert.equal(result.serverTime, null, 'a failed check has no server time');
});

test('the page failing the keyword check is a content failure', async () => {
    const result = await checkServerStatus(site(`http://up.test:${httpPort}/`, { monitoring: { keyword: { text: 'welcome', mode: 'present' } } }));
    assert.equal(result.status, 'down');
    assert.equal(result.failure.kind, 'content');
    assert.equal(result.failedPhase, 'content');
    assert.equal(result.resolvedAddress, '127.0.0.1');
    assert.ok(result.timings.ttfb >= 0);
});

test('a TCP check that is refused reports dns and connect, and says connect', async () => {
    const result = await checkServerStatus({ url: `127.0.0.1:${closedPort}`, type: 'tcp', monitoring: {} });
    assert.equal(result.status, 'down');
    assert.equal(result.failedPhase, 'connect');
    assert.deepEqual(Object.keys(result.timings).sort(), ['connect', 'dns']);
});

test('a check that works has no failed step, and still reports where the name resolved', async () => {
    const result = await checkServerStatus(site(`http://up.test:${httpPort}/`));
    assert.equal(result.status, 'up');
    assert.equal(result.failedPhase, null);
    assert.equal(result.resolvedAddress, '127.0.0.1');
    assert.ok(Number.isFinite(result.serverTime));
});

test('an address that is not allowed has no failed step: nothing was checked', async () => {
    delete process.env.ALLOW_PRIVATE_TARGETS;
    try {
        const result = await checkServerStatus(site('http://127.0.0.1:9/'));
        assert.equal(result.failure.kind, 'blocked');
        assert.equal(result.failedPhase, null);
    } finally {
        process.env.ALLOW_PRIVATE_TARGETS = 'true';
    }
});
