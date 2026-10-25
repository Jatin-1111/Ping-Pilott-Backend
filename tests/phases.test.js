// Run with: npm test
// Where the time of a check went (DNS, connect, TLS, waiting for the server), stored with the check, shown in history,
// and used by a slow alert to say which part was slow.
//
// The sockets are real and local; the private-address guard is off, as in local development. A name such as
// slow-dns.test is made to resolve to 127.0.0.1 after a delay, and the TLS server holds the handshake at the SNI step,
// so each phase can be given a known length. tests/fixtures/test-tls.*.pem is a throwaway self-signed certificate that
// protects nothing: checks do not validate certificates, and it is used only here.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import mongoose from 'mongoose';
import { checkServerStatus } from '../services/monitoringService.js';
import { phaseTimings, connectTimings } from '../utils/requestTiming.js';
import { cleanTimings, serverTimeOf, dominantPhase, describeDominantPhase } from '../utils/timings.js';
import { checkExtras } from '../utils/checkRecord.js';
import { planCheckUpdate } from '../utils/alertDecision.js';
import Server from '../models/Server.js';
import { buildAlertMessage } from '../utils/alertFeed.js';
import { enqueueAlert } from '../services/alertOutbox.js';
import ServerCheck from '../models/ServerCheck.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

const DNS_DELAY = 60;
const SNI_DELAY = 80;
const FAKE_NAMES = new Set(['slow-dns.test', 'sni.test']);

let httpServer;
let httpPort;
let httpsServer;
let httpsPort;
const realLookup = dns.lookup;

const answer = (res, status = 200, headers = {}) => {
    res.writeHead(status, { 'Content-Length': 2, ...headers });
    res.end('ok');
};

before(async () => {
    process.env.ALLOW_PRIVATE_TARGETS = 'true';

    // Names made up for the test resolve to this machine, after a delay
    dns.lookup = (hostname, options, callback) => {
        if (FAKE_NAMES.has(hostname)) {
            setTimeout(() => callback(null, [{ address: '127.0.0.1', family: 4 }]), DNS_DELAY);
        } else {
            realLookup(hostname, options, callback);
        }
    };

    httpServer = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/delay-150') {
            await sleep(150);
            answer(res);
        } else if (url.pathname === '/delay') {
            await sleep(Number(url.searchParams.get('ms')));
            answer(res);
        } else if (url.pathname === '/redir') {
            await sleep(100);
            res.writeHead(302, { Location: '/delay-150', 'Content-Length': 0 }).end();
        } else if (url.pathname === '/head-refused') {
            if (req.method === 'HEAD') {
                await sleep(400);
                answer(res, 405);
            } else {
                await sleep(100);
                answer(res);
            }
        } else {
            answer(res);
        }
    });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    httpPort = httpServer.address().port;

    const key = fixture('test-tls.key.pem');
    const cert = fixture('test-tls.cert.pem');
    const context = tls.createSecureContext({ key, cert });
    httpsServer = https.createServer({
        key,
        cert,
        // Held here, the handshake takes SNI_DELAY longer: a client that sends a name (not an address) goes through this
        SNICallback: (servername, callback) => setTimeout(() => callback(null, context), SNI_DELAY)
    }, (req, res) => answer(res));
    await new Promise((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
    httpsPort = httpsServer.address().port;
});

after(async () => {
    dns.lookup = realLookup;
    for (const server of [httpServer, httpsServer]) {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
});

const site = (url) => ({ url, type: 'website', monitoring: {} });
const sum = (t) => t.dns + t.connect + t.tls + t.ttfb + t.redirects;

// ── phaseTimings: the arithmetic ──

test('the phases of the last hop add up to the whole, with what came before it as redirects', () => {
    const hop = { startedAt: 100, lookupAt: 130, connectAt: 150, secureAt: 200 };
    const timings = phaseTimings(hop, 90, 400);
    assert.deepEqual(timings, { dns: 30, connect: 20, tls: 50, ttfb: 200, redirects: 10 });
    assert.equal(sum(timings), 400 - 90);
});

test('no lookup means dns 0, no TLS means tls 0, and no socket at all means nothing to report', () => {
    const plain = phaseTimings({ startedAt: 0, lookupAt: null, connectAt: 5, secureAt: null }, 0, 105);
    assert.deepEqual(plain, { dns: 0, connect: 5, tls: 0, ttfb: 100, redirects: 0 });

    assert.equal(phaseTimings(undefined, 0, 100), null);
    assert.deepEqual(connectTimings({ startedAt: 10, lookupAt: 40 }, 55), { dns: 30, connect: 15 });
    assert.deepEqual(connectTimings({ startedAt: 10, lookupAt: null }, 15), { dns: 0, connect: 5 });
    assert.equal(connectTimings(undefined, 5), null);
});

// ── real sockets ──

test('an address has no DNS time, plain HTTP has no TLS time, and the wait for the server is the wait for the server', async () => {
    const result = await checkServerStatus(site(`http://127.0.0.1:${httpPort}/delay-150`));
    const t = result.timings;

    assert.equal(result.status, 'up');
    assert.deepEqual(Object.keys(t).sort(), ['connect', 'dns', 'redirects', 'tls', 'ttfb']);
    assert.equal(t.dns, 0);
    assert.equal(t.tls, 0);
    assert.ok(t.ttfb >= 140 && t.ttfb < 400, `ttfb ${t.ttfb}`);
    assert.ok(t.connect < 100, `connect ${t.connect}`);
    assert.ok(Math.abs(sum(t) - result.responseTime) <= 3, `phases ${sum(t)} against total ${result.responseTime}`);
});

test('the time spent resolving a name is the DNS phase', async () => {
    const result = await checkServerStatus(site(`http://slow-dns.test:${httpPort}/`));
    assert.equal(result.status, 'up');
    assert.ok(result.timings.dns >= DNS_DELAY - 5, `dns ${result.timings.dns}`);
    assert.ok(result.timings.dns < 500, `dns ${result.timings.dns}`);
    assert.ok(Math.abs(sum(result.timings) - result.responseTime) <= 3);
});

test('a redirect is counted as redirects, and the phases describe the page it ended on', async () => {
    const result = await checkServerStatus(site(`http://127.0.0.1:${httpPort}/redir`));
    const t = result.timings;

    assert.equal(result.status, 'up');
    assert.ok(t.redirects >= 90, `the 100 ms before the redirect is in redirects, got ${t.redirects}`);
    assert.ok(t.ttfb >= 140 && t.ttfb < 230, `ttfb is the final 150 ms hop alone, got ${t.ttfb}`);
    assert.ok(Math.abs(sum(t) - result.responseTime) <= 3, `phases ${sum(t)} against total ${result.responseTime}`);
});

test('when HEAD is turned away, the phases are those of the GET that answered', async () => {
    const result = await checkServerStatus(site(`http://127.0.0.1:${httpPort}/head-refused`));
    assert.equal(result.status, 'up');
    assert.ok(result.timings.ttfb >= 90 && result.timings.ttfb < 300, `ttfb ${result.timings.ttfb}, the 400 ms HEAD is left out`);
    assert.ok(result.timings.redirects < 20, `nothing but setup comes before the GET, got ${result.timings.redirects}`);
});

test('the TLS handshake is its own phase', async () => {
    const result = await checkServerStatus(site(`https://sni.test:${httpsPort}/`));
    const t = result.timings;

    assert.equal(result.status, 'up', result.error);
    assert.ok(t.dns >= DNS_DELAY - 5, `dns ${t.dns}`);
    assert.ok(t.tls >= SNI_DELAY - 10, `tls ${t.tls}`);
    assert.ok(t.connect < 100, `connect ${t.connect}`);
    assert.ok(Math.abs(sum(t) - result.responseTime) <= 3, `phases ${sum(t)} against total ${result.responseTime}`);
});

test('checks running at the same time each get their own timings, not each other\'s', async () => {
    const waits = [20, 60, 100, 140, 180, 220, 260, 300, 340, 380, 420, 460];
    const results = await Promise.all(waits.map((ms) => checkServerStatus(site(`http://127.0.0.1:${httpPort}/delay?ms=${ms}`))));

    results.forEach((result, i) => {
        assert.equal(result.status, 'up');
        assert.ok(result.timings.ttfb >= waits[i] - 10, `check ${i} waited ${waits[i]} ms, ttfb ${result.timings.ttfb}`);
        assert.ok(result.timings.ttfb < waits[i] + 150, `check ${i} waited ${waits[i]} ms, ttfb ${result.timings.ttfb}`);
    });
});

test('a TCP check reports dns and connect only, and a failed check has no timings', async () => {
    const tcp = net.createServer((socket) => socket.end());
    await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    const port = tcp.address().port;

    const up = await checkServerStatus({ url: `127.0.0.1:${port}`, type: 'tcp', monitoring: {} });
    assert.equal(up.status, 'up');
    assert.deepEqual(Object.keys(up.timings).sort(), ['connect', 'dns']);
    assert.equal(up.timings.dns, 0);

    await new Promise((resolve) => tcp.close(resolve));
    const down = await checkServerStatus({ url: `127.0.0.1:${port}`, type: 'tcp', monitoring: {} });
    assert.equal(down.status, 'down');
    assert.equal(down.timings, null);
});

// ── server time: the true reading ──

test('server time is the time to first byte minus the connect, which is one round trip', () => {
    assert.equal(serverTimeOf({ dns: 4, connect: 40, tls: 80, ttfb: 300, redirects: 0 }), 260);
    assert.equal(serverTimeOf({ connect: 0, ttfb: 25 }), 25, 'no distance to take out: all of it is the server');
});

test('the same server reads the same however far away the checker is', () => {
    // 25 ms of the server's own time, seen from next door, from another continent, and from the far side of the world
    const near = serverTimeOf({ dns: 2, connect: 1, tls: 2, ttfb: 26, redirects: 0 });
    const far = serverTimeOf({ dns: 20, connect: 150, tls: 300, ttfb: 175, redirects: 0 });
    const farthest = serverTimeOf({ dns: 60, connect: 340, tls: 680, ttfb: 365, redirects: 0 });
    assert.deepEqual([near, far, farthest], [25, 25, 25]);
});

test('it is never negative, and is null when it cannot be told', () => {
    assert.equal(serverTimeOf({ connect: 80, ttfb: 60 }), 0, 'a slow connect and a quick answer: not below zero');
    assert.equal(serverTimeOf({ dns: 5, connect: 40 }), null, 'no response time: a TCP check');
    assert.equal(serverTimeOf({ ttfb: 100 }), null, 'no connect to take out');
    for (const nothing of [null, undefined, {}, 'x', { connect: 'a', ttfb: 'b' }]) assert.equal(serverTimeOf(nothing), null, String(nothing));
});

test('a real check reports the server\'s own time apart from the rest', async () => {
    const result = await checkServerStatus(site(`http://127.0.0.1:${httpPort}/delay-150`));
    assert.equal(result.status, 'up');
    assert.equal(result.serverTime, Math.max(0, result.timings.ttfb - result.timings.connect));
    assert.ok(result.serverTime >= 140 && result.serverTime < 400, `the server took 150 ms, got ${result.serverTime}`);
    const network = result.responseTime - result.serverTime;
    assert.ok(network >= 0 && network < 200, `on this machine the network is a few ms, got ${network}`);
});

test('after a redirect the server time is the page it ended on, not the sum of the pages', async () => {
    const result = await checkServerStatus(site(`http://127.0.0.1:${httpPort}/redir`));
    assert.equal(result.status, 'up');
    assert.ok(result.serverTime >= 140 && result.serverTime < 230, `the final page took 150 ms, got ${result.serverTime}`);
    assert.ok(result.responseTime >= 250, 'while the whole took the 100 ms redirect as well');
});

test('a TCP check and a failed check have no server time', async () => {
    const tcp = net.createServer((socket) => socket.end());
    await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    const port = tcp.address().port;
    assert.equal((await checkServerStatus({ url: `127.0.0.1:${port}`, type: 'tcp', monitoring: {} })).serverTime, null);

    await new Promise((resolve) => tcp.close(resolve));
    const down = await checkServerStatus({ url: `127.0.0.1:${port}`, type: 'tcp', monitoring: {} });
    assert.equal(down.status, 'down');
    assert.equal(down.serverTime, null);
});

test('it is saved with the check, and on the server, and cleared when the server is not up', () => {
    assert.equal(checkExtras({ serverTime: 25.4 }).serverTime, 25);
    assert.equal(checkExtras({ serverTime: 0 }).serverTime, 0, 'zero is a reading');
    for (const none of [null, undefined, -1, 'x', NaN]) assert.equal('serverTime' in checkExtras({ serverTime: none }), false, String(none));

    const NOW = new Date('2026-10-25T10:00:00Z');
    const up = planCheckUpdate({ server: { _id: 's1', status: 'up', monitoring: { frequency: 5 } }, checkResult: { status: 'up', responseTime: 735, serverTime: 25, error: null, slow: false, failure: null }, now: NOW });
    assert.equal(up.$set.serverTime, 25);
    const down = planCheckUpdate({ server: { _id: 's1', status: 'up', monitoring: { frequency: 5 } }, checkResult: { status: 'down', responseTime: null, serverTime: null, error: 'x', slow: false, failure: { kind: 'other' } }, now: NOW });
    assert.equal(down.$set.serverTime, null);
    const older = planCheckUpdate({ server: { _id: 's1', status: 'up', monitoring: { frequency: 5 } }, checkResult: { status: 'up', responseTime: 100, error: null, slow: false, failure: null }, now: NOW });
    assert.equal(older.$set.serverTime, null, 'a result without it clears the old one rather than keeping a stale reading');
});

test('a stored check and a server accept it', () => {
    const id = new mongoose.Types.ObjectId();
    const check = new ServerCheck({ serverId: id, status: 'up', responseTime: 735, serverTime: 25 });
    assert.equal(check.validateSync(), undefined);
    assert.equal(check.toObject().serverTime, 25);
    assert.equal(new ServerCheck({ serverId: id, status: 'up' }).toObject().serverTime, undefined);
    assert.equal(new Server({ name: 'a', url: 'a.com', uploadedBy: id }).serverTime, null);
});

// ── what is stored, shown and said ──

test('cleanTimings keeps the known phases as whole non-negative numbers, and nothing else', () => {
    assert.deepEqual(cleanTimings({ dns: 12.6, connect: 3, tls: 0, ttfb: 140, redirects: 0, junk: 5 }), { dns: 13, connect: 3, tls: 0, ttfb: 140, redirects: 0 });
    assert.deepEqual(cleanTimings({ dns: 5, ttfb: 'x', tls: -4, connect: null }), { dns: 5 });
    for (const bad of [null, undefined, 'x', 5, {}, { ttfb: 'x' }]) assert.equal(cleanTimings(bad), null, String(bad));
});

test('the dominant phase must be at least half of the time, or nothing is said', () => {
    assert.deepEqual(dominantPhase({ dns: 820, connect: 20, tls: 60, ttfb: 340, redirects: 0 }, 1240), { phase: 'dns', label: 'DNS lookup', ms: 820, total: 1240 });
    assert.equal(dominantPhase({ dns: 500, connect: 100, tls: 100, ttfb: 300, redirects: 0 }, 1000)?.phase, 'dns', 'exactly half is still reported');
    assert.equal(dominantPhase({ dns: 499, connect: 100, tls: 100, ttfb: 301, redirects: 0 }, 1000), null, 'just under half is not');
    assert.equal(dominantPhase({ dns: 300, connect: 200, tls: 200, ttfb: 299, redirects: 0 }, 1000), null, 'no phase explains it');
    assert.equal(dominantPhase(null, 1000), null);
    assert.equal(dominantPhase({ dns: 0, ttfb: 0 }, 0), null);

    // without a total the phases' own sum is used
    assert.equal(dominantPhase({ ttfb: 900, dns: 100 })?.phase, 'ttfb');
});

test('the sentence names the phase and the numbers', () => {
    assert.equal(
        describeDominantPhase({ dns: 820, connect: 20, tls: 60, ttfb: 340, redirects: 0 }, 1240),
        'Most of the time was spent on DNS lookup (820 of 1240 ms).'
    );
    assert.equal(
        describeDominantPhase({ dns: 5, connect: 5, tls: 20, ttfb: 1100, redirects: 0 }, 1130),
        "Most of the time was spent on the server's response (1100 of 1130 ms)."
    );
    assert.equal(describeDominantPhase({ dns: 300, connect: 300, tls: 300, ttfb: 300, redirects: 0 }, 1200), null);
});

test('a slow alert says which part was slow, and reads as before when there are no timings', () => {
    const server = { monitoring: { alerts: { responseThreshold: 1000 } } };
    const timings = { dns: 820, connect: 20, tls: 60, ttfb: 340, redirects: 0 };

    assert.equal(
        buildAlertMessage('slow_response', { responseTime: 1240, slowStreak: 3, timings }, server),
        'Slower than your 1000 ms limit for 3 checks in a row, latest 1240 ms. Most of the time was spent on DNS lookup (820 of 1240 ms).'
    );
    assert.equal(
        buildAlertMessage('slow_response', { responseTime: 1240, timings }, server),
        'Responded in 1240 ms, above your 1000 ms limit. Most of the time was spent on DNS lookup (820 of 1240 ms).'
    );
    assert.equal(
        buildAlertMessage('slow_response', { responseTime: 1240, slowStreak: 3 }, server),
        'Slower than your 1000 ms limit for 3 checks in a row, latest 1240 ms.'
    );
    // other alert types are untouched
    assert.equal(buildAlertMessage('server_recovery', { responseTime: 212, timings }), 'Back online, responding in 212 ms.');
});

test('the alert row keeps the timings and the streak of the check that raised it', async () => {
    let created;
    const model = {
        create: async (doc) => { created = doc; return { _id: 'p1', serverId: doc.serverId, alertType: doc.alertType, priority: doc.priority }; },
        updateOne: async () => ({})
    };
    const queue = { add: async () => ({}) };
    const checkResult = { status: 'up', responseTime: 1240, error: 'Slow response', slow: true, slowStreak: 3, timings: { dns: 820, connect: 20, tls: 60, ttfb: 340, redirects: 0, junk: 1 } };

    await enqueueAlert({ server: { _id: 's1', uploadedBy: 'u1' }, alertType: 'slow_response', previous: 'up', checkResult }, { model, queue, shouldSend: () => true });
    assert.deepEqual(created.checkResult.timings, { dns: 820, connect: 20, tls: 60, ttfb: 340, redirects: 0 });
    assert.equal(created.checkResult.slowStreak, 3);

    await enqueueAlert({ server: { _id: 's1', uploadedBy: 'u1' }, alertType: 'server_down', previous: 'up', checkResult: { status: 'down', responseTime: null, error: 'x', slow: false, timings: null } }, { model, queue, shouldSend: () => true });
    assert.equal('timings' in created.checkResult, false, 'a failed check has no timings to keep');
});

test('a stored check keeps its timings, and a check without them has no timings field', () => {
    const withTimings = new ServerCheck({ serverId: new mongoose.Types.ObjectId(), status: 'up', responseTime: 300, timings: { dns: 10, connect: 5, tls: 20, ttfb: 260, redirects: 0 } });
    assert.equal(withTimings.validateSync(), undefined);
    assert.deepEqual(withTimings.toObject().timings, { dns: 10, connect: 5, tls: 20, ttfb: 260, redirects: 0 });

    const without = new ServerCheck({ serverId: new mongoose.Types.ObjectId(), status: 'down', error: 'x' });
    assert.equal(without.validateSync(), undefined);
    assert.equal(without.toObject({ minimize: true }).timings, undefined);
});
