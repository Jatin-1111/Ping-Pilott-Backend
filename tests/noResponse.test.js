// Run with: npm test
// A timeout is two different problems. Never connecting in time (kind "timeout") points at the network, a firewall or
// a machine that is off. Connecting and then getting no answer (kind "no_response") points at an app that is stuck.
// utils/requestTiming.js marks an error with how far the connection got, and utils/failures.js reads it.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import axios from 'axios';
import { TimedHttpAgent, timedRequest, reachedServer } from '../utils/requestTiming.js';
import { classifyFailure, FAILURE_KINDS } from '../utils/failures.js';
import { diagnose } from '../utils/diagnosis.js';

const code = (c) => Object.assign(new Error('boom'), { code: c });

// ---- the classifier ----

test('a timeout after the connection was up is "no_response", and one before it is "timeout"', () => {
    for (const errCode of ['ETIMEDOUT', 'ECONNABORTED', 'ERR_CANCELED']) {
        assert.deepEqual(
            classifyFailure(Object.assign(code(errCode), { reachedServer: true }), { timeoutSeconds: 10 }),
            { kind: 'no_response', message: 'Connected, but no response after 10s', statusCode: null },
            errCode
        );
        assert.equal(classifyFailure(Object.assign(code(errCode), { reachedServer: false })).kind, 'timeout', errCode);
        assert.equal(classifyFailure(code(errCode)).kind, 'timeout', 'an error that was never marked is a timeout, as before');
    }
    assert.equal(classifyFailure(Object.assign(code('ETIMEDOUT'), { reachedServer: true }), { timeoutSeconds: 30 }).message, 'Connected, but no response after 30s');
});

test('only a timeout is split: a refused or reset connection keeps its kind whatever the mark says', () => {
    assert.equal(classifyFailure(Object.assign(code('ECONNREFUSED'), { reachedServer: true })).kind, 'refused');
    assert.equal(classifyFailure(Object.assign(code('ECONNRESET'), { reachedServer: true })).kind, 'reset');
});

test('no_response is a known kind with a diagnosis that says the connection worked', () => {
    assert.ok(FAILURE_KINDS.includes('no_response'));
    const d = diagnose({ kind: 'no_response' });
    assert.match(d.title, /accepted the connection/);
    assert.match(d.cause, /likely stuck/);
    assert.notEqual(d.title, diagnose({ kind: 'timeout' }).title);
});

// ---- real sockets ----

let silent;
let silentPort;
let closedPort;

before(async () => {
    // accepts the connection and never says anything
    silent = net.createServer((socket) => { socket.on('error', () => {}); });
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    silentPort = silent.address().port;

    const closed = net.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    closedPort = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
});

after(async () => {
    silent.closeAllConnections?.();
    await new Promise((resolve) => silent.close(resolve));
});

const get = (port, timeout) => timedRequest(() => axios.get(`http://127.0.0.1:${port}/`, {
    timeout,
    httpAgent: new TimedHttpAgent({ keepAlive: false })
}));

test('a server that accepts the connection and never answers is marked as reached', async () => {
    await assert.rejects(get(silentPort, 300), (err) => {
        assert.equal(err.reachedServer, true);
        assert.equal(classifyFailure(err).kind, 'no_response');
        return true;
    });
});

test('a connection that never opened is not marked as reached', async () => {
    await assert.rejects(get(closedPort, 300), (err) => {
        assert.equal(err.reachedServer, false);
        assert.equal(classifyFailure(err).kind, 'refused');
        return true;
    });
});

test('reachedServer needs a connection, and the TLS handshake too when the socket is a TLS one', () => {
    assert.equal(reachedServer(undefined), false);
    assert.equal(reachedServer({ connectAt: null, secure: false }), false);
    assert.equal(reachedServer({ connectAt: 5, secure: false }), true);
    assert.equal(reachedServer({ connectAt: 5, secure: true, secureAt: null }), false, 'connected but the handshake never finished');
    assert.equal(reachedServer({ connectAt: 5, secure: true, secureAt: 9 }), true);
});
