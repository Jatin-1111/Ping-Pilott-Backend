// Run with: npm test
// A failed check says why as a value (kind and, for HTTP, the status code), not only as a sentence. The sentence the
// user reads is unchanged. The kind is stored on the check, the server and the incident, returned by the history and
// incident APIs, carried to the webhook, and counted in the worker's minute summary.

import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import mongoose from 'mongoose';
import { classifyFailure, failureOf, HttpStatusError, InvalidAddressError, FAILURE_KINDS } from '../utils/failures.js';
import { checkExtras } from '../utils/checkRecord.js';
import { checkServerStatus } from '../services/monitoringService.js';
import { planCheckUpdate } from '../utils/alertDecision.js';
import { recordStatusChange } from '../services/incidentService.js';
import { buildIncidentList } from '../utils/incidentList.js';
import { enqueueAlert } from '../services/alertOutbox.js';
import { sendAlertChannels } from '../services/alertService.js';
import { createLoadMonitor, formatSummary } from '../services/loadMonitor.js';
import ServerCheck from '../models/ServerCheck.js';
import Incident from '../models/Incident.js';
import Server from '../models/Server.js';

const code = (c, message = 'boom') => Object.assign(new Error(message), { code: c });

// ── the classifier ──

test('each socket and resolver error code has a kind, and the sentence the user reads is what it always was', () => {
    const table = [
        ['ECONNREFUSED', 'refused', 'Connection refused'],
        ['ECONNRESET', 'reset', 'Connection reset by the server'],
        ['ENOTFOUND', 'dns', 'DNS lookup failed (host not found)'],
        ['EAI_AGAIN', 'dns', 'DNS lookup failed (host not found)'],
        ['ETIMEDOUT', 'timeout', 'Timed out after 10s'],
        ['ECONNABORTED', 'timeout', 'Timed out after 10s'],
        ['ERR_CANCELED', 'timeout', 'Timed out after 10s'],
        ['EHOSTUNREACH', 'unreachable', 'Host unreachable'],
        ['ENETUNREACH', 'unreachable', 'Host unreachable']
    ];
    for (const [errCode, kind, message] of table) {
        assert.deepEqual(classifyFailure(code(errCode)), { kind, message, statusCode: null }, errCode);
    }
    assert.equal(classifyFailure(code('ETIMEDOUT'), { timeoutSeconds: 30 }).message, 'Timed out after 30s');
});

test('TLS failures are kind tls and keep the library message', () => {
    for (const errCode of ['EPROTO', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT']) {
        assert.deepEqual(classifyFailure(code(errCode, 'handshake failed')), { kind: 'tls', message: 'handshake failed', statusCode: null }, errCode);
    }
});

test('private addresses are blocked, an HTTP status keeps its number, a bad address is invalid, anything else is other', () => {
    assert.deepEqual(classifyFailure(code('PRIVATE_TARGET', 'Blocked: 10.0.0.1 is a private or internal address.')), {
        kind: 'blocked', message: 'Blocked: 10.0.0.1 is a private or internal address.', statusCode: null
    });

    const http503 = classifyFailure(new HttpStatusError(503, 'Service Unavailable'));
    assert.deepEqual(http503, { kind: 'http', message: 'HTTP 503: Service Unavailable', statusCode: 503 });
    assert.equal(classifyFailure(new HttpStatusError(404)).message, 'HTTP 404');

    assert.deepEqual(classifyFailure(new InvalidAddressError()), { kind: 'invalid', message: 'Invalid address (expected host:port)', statusCode: null });

    assert.deepEqual(classifyFailure(new Error('something odd')), { kind: 'other', message: 'something odd', statusCode: null });
    assert.deepEqual(classifyFailure({}), { kind: 'other', message: 'Request failed', statusCode: null });
    assert.deepEqual(classifyFailure(undefined), { kind: 'other', message: 'Request failed', statusCode: null });
});

test('every kind the classifier can return is a known kind', () => {
    const seen = [code('ECONNREFUSED'), code('ECONNRESET'), code('ENOTFOUND'), code('ETIMEDOUT'), code('EHOSTUNREACH'), code('EPROTO'),
        new HttpStatusError(500), code('PRIVATE_TARGET'), new InvalidAddressError(), new Error('x')].map((e) => classifyFailure(e).kind);
    for (const kind of seen) assert.ok(FAILURE_KINDS.includes(kind), kind);
});

test('failureOf is { kind } with the status code only when there is one, and null without a failure', () => {
    assert.deepEqual(failureOf({ kind: 'refused', message: 'x', statusCode: null }), { kind: 'refused' });
    assert.deepEqual(failureOf({ kind: 'http', message: 'x', statusCode: 503 }), { kind: 'http', statusCode: 503 });
    assert.equal(failureOf(null), null);
});

// ── real checks ──

let server;
let port;

before(async () => {
    process.env.ALLOW_PRIVATE_TARGETS = 'true';
    server = http.createServer((req, res) => {
        const status = Number(new URL(req.url, 'http://x').searchParams.get('status') || 200);
        res.writeHead(status, { 'Content-Length': 2 });
        res.end(req.method === 'HEAD' ? undefined : 'ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
});

after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
});

const site = (url, extra = {}) => ({ url, type: 'website', monitoring: {}, ...extra });

test('a check that comes back up has no failure and carries the status code it got', async () => {
    const result = await checkServerStatus(site(`http://127.0.0.1:${port}/?status=200`));
    assert.equal(result.status, 'up');
    assert.equal(result.failure, null);
    assert.equal(result.statusCode, 200);

    const redirectless = await checkServerStatus(site(`http://127.0.0.1:${port}/?status=204`));
    assert.equal(redirectless.statusCode, 204);
});

test('an HTTP error is kind http with the status code, and the sentence is as before', async () => {
    const result = await checkServerStatus(site(`http://127.0.0.1:${port}/?status=503`));
    assert.equal(result.status, 'down');
    assert.match(result.error, /^HTTP 503/);
    assert.deepEqual(result.failure, { kind: 'http', statusCode: 503 });
    assert.equal(result.statusCode, 503);

    const forbidden = await checkServerStatus(site(`http://127.0.0.1:${port}/?status=403`));
    assert.deepEqual(forbidden.failure, { kind: 'http', statusCode: 403 });
});

test('a refused connection is kind refused, for a website and for a TCP check', async () => {
    const closed = net.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadPort = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));

    const web = await checkServerStatus(site(`http://127.0.0.1:${deadPort}/`));
    assert.equal(web.status, 'down');
    assert.equal(web.error, 'Connection refused');
    assert.deepEqual(web.failure, { kind: 'refused' });
    assert.equal(web.statusCode, null);

    const tcp = await checkServerStatus({ url: `127.0.0.1:${deadPort}`, type: 'tcp', monitoring: {} });
    assert.deepEqual(tcp.failure, { kind: 'refused' });
});

test('a TCP address that cannot be parsed is kind invalid', async () => {
    // a port out of range fails before any connection is attempted
    const bad = await checkServerStatus({ url: 'host:99999', type: 'tcp', monitoring: {} });
    assert.equal(bad.status, 'down');
    assert.equal(bad.error, 'Invalid address (expected host:port)');
    assert.deepEqual(bad.failure, { kind: 'invalid' });
});

test('a name that does not resolve is kind dns, and a private address is kind blocked', async () => {
    delete process.env.ALLOW_PRIVATE_TARGETS;
    const realLookup = dns.lookup;
    try {
        dns.lookup = (hostname, options, callback) => {
            if (hostname === 'missing-host.test') return callback(code('ENOTFOUND'));
            if (hostname === 'sneaky.test') return callback(null, [{ address: '127.0.0.1', family: 4 }]);
            return realLookup(hostname, options, callback);
        };
        const missing = await checkServerStatus(site('missing-host.test'));
        assert.equal(missing.error, 'DNS lookup failed (host not found)');
        assert.deepEqual(missing.failure, { kind: 'dns' });

        const sneaky = await checkServerStatus(site('sneaky.test'));
        assert.match(sneaky.error, /private or internal address/);
        assert.deepEqual(sneaky.failure, { kind: 'blocked' });
    } finally {
        dns.lookup = realLookup;
        process.env.ALLOW_PRIVATE_TARGETS = 'true';
    }
});

// ── what is stored ──

test('the history row carries only the extras that apply', () => {
    assert.deepEqual(checkExtras({ status: 'up', statusCode: 200, failure: null, timings: null }), { statusCode: 200 });
    assert.deepEqual(checkExtras({ status: 'down', statusCode: null, failure: { kind: 'timeout' } }), { failureKind: 'timeout' });
    assert.deepEqual(checkExtras({ status: 'down', statusCode: 503, failure: { kind: 'http', statusCode: 503 } }), { failureKind: 'http', statusCode: 503 });
    assert.deepEqual(
        checkExtras({ statusCode: 200, loadSuspect: true, timings: { dns: 3, connect: 1, tls: 0, ttfb: 90, redirects: 0 } }),
        { statusCode: 200, loadSuspect: true, timings: { dns: 3, connect: 1, tls: 0, ttfb: 90, redirects: 0 } }
    );
    assert.deepEqual(checkExtras({}), {});
    assert.deepEqual(checkExtras(undefined), {});
    assert.deepEqual(checkExtras({ statusCode: 'x', loadSuspect: false, failure: {} }), {}, 'junk and false values are left out');
});

test('a stored check, server and incident accept the failure kind', () => {
    const id = new mongoose.Types.ObjectId();
    const check = new ServerCheck({ serverId: id, status: 'down', error: 'HTTP 503', failureKind: 'http', statusCode: 503 });
    assert.equal(check.validateSync(), undefined);
    assert.equal(check.toObject().failureKind, 'http');
    assert.equal(check.toObject().statusCode, 503);

    const incident = new Incident({ serverId: id, userId: id, startedAt: new Date(), failureKind: 'timeout' });
    assert.equal(incident.validateSync(), undefined);
    assert.equal(incident.failureKind, 'timeout');
    assert.equal(new Incident({ serverId: id, userId: id, startedAt: new Date() }).failureKind, null);

    assert.equal(new Server({ name: 'a', url: 'a.com', uploadedBy: id }).failureKind, null);
});

test('saving a check on the server records the kind, and clears it when the server is up', () => {
    const NOW = new Date('2026-10-25T10:00:00Z');
    const down = planCheckUpdate({
        server: { _id: 's1', status: 'up', monitoring: { frequency: 5 } },
        checkResult: { status: 'down', responseTime: null, error: 'HTTP 503', slow: false, failure: { kind: 'http', statusCode: 503 }, statusCode: 503 },
        now: NOW
    });
    assert.equal(down.$set.failureKind, 'http');

    const up = planCheckUpdate({
        server: { _id: 's1', status: 'down', monitoring: { frequency: 5 } },
        checkResult: { status: 'up', responseTime: 120, error: null, slow: false, failure: null, statusCode: 200 },
        now: NOW
    });
    assert.equal(up.$set.failureKind, null);
});

test('an incident opens with the kind of the failure that started it, and the incident list returns it', async () => {
    const created = [];
    const model = { create: async (doc) => { created.push(doc); }, updateOne: async () => {} };
    const NOW = new Date('2026-10-25T10:00:00Z');
    await recordStatusChange({ _id: 's1', uploadedBy: 'u1', name: 'Shop' }, 'up', { status: 'down', error: 'Timed out after 10s', failure: { kind: 'timeout' } }, NOW, model);
    assert.equal(created[0].failureKind, 'timeout');

    await recordStatusChange({ _id: 's2', uploadedBy: 'u1', name: 'Docs' }, 'up', { status: 'down', error: 'x' }, NOW, model);
    assert.equal(created[1].failureKind, null, 'an older caller without a failure still works');

    const list = buildIncidentList(
        [{ _id: 'i1', serverId: 's1', startedAt: NOW, endedAt: null, open: true, error: 'Timed out after 10s', failureKind: 'timeout' },
         { _id: 'i2', serverId: 's1', startedAt: NOW, endedAt: null, open: true, error: 'old' }],
        [{ _id: 's1', name: 'Shop', url: 'shop.example' }],
        { now: NOW.getTime() }
    );
    assert.equal(list.incidents[0].failureKind, 'timeout');
    assert.equal(list.incidents[1].failureKind, null, 'an incident from before the field has none');
});

// ── alerts and the webhook ──

test('the alert row keeps the kind and status code, and the webhook payload carries them', async () => {
    let row;
    const model = { create: async (doc) => { row = doc; return { _id: 'p1', serverId: doc.serverId, alertType: doc.alertType, priority: doc.priority }; }, updateOne: async () => ({}) };
    const down = { status: 'down', responseTime: null, error: 'HTTP 503', slow: false, failure: { kind: 'http', statusCode: 503 }, statusCode: 503, timings: null };
    await enqueueAlert({ server: { _id: 's1', uploadedBy: 'u1' }, alertType: 'server_down', previous: 'up', checkResult: down }, { model, queue: { add: async () => ({}) }, shouldSend: () => true });
    assert.equal(row.checkResult.failureKind, 'http');
    assert.equal(row.checkResult.statusCode, 503);

    let payload;
    await sendAlertChannels(
        { _id: 's1', name: 'Shop', url: 'shop.example', status: 'up', contactEmails: [], monitoring: { alerts: { webhookUrl: 'https://hooks.example/x' } } },
        'server_down', row.checkResult, {},
        { sendWebhook: async (_server, _type, body) => { payload = body; }, sendEmail: async () => {} }
    );
    assert.equal(payload.failureKind, 'http');
    assert.equal(payload.statusCode, 503);
    assert.equal(payload.error, 'HTTP 503');

    // a down alert from a failure with no kind (an alert row from before this change) has neither key
    let old;
    await sendAlertChannels(
        { _id: 's1', name: 'Shop', url: 'shop.example', status: 'up', contactEmails: [], monitoring: { alerts: { webhookUrl: 'https://hooks.example/x' } } },
        'server_down', { status: 'down', error: 'x' }, {},
        { sendWebhook: async (_s, _t, body) => { old = body; }, sendEmail: async () => {} }
    );
    assert.equal('failureKind' in old, false);
    assert.equal('statusCode' in old, false);
});

// ── the minute summary ──

test('the summary counts failures by kind, and says them most frequent first', () => {
    const monitor = createLoadMonitor({ source: () => ({ peek: () => 0, read: () => 0 }) });
    monitor.start();
    for (let i = 0; i < 5; i += 1) monitor.recordCheck({ status: 'down', failure: { kind: 'timeout' }, timings: null });
    for (let i = 0; i < 2; i += 1) monitor.recordCheck({ status: 'down', failure: { kind: 'dns' }, timings: null });
    monitor.recordCheck({ status: 'down', failure: { kind: 'http', statusCode: 503 }, timings: null });
    monitor.recordCheck({ status: 'up', failure: null, timings: { dns: 4 } });

    const summary = monitor.summarize();
    assert.deepEqual(summary.failures, { timeout: 5, dns: 2, http: 1 });
    assert.equal(summary.checks, 9);
    assert.match(formatSummary(summary), /; failed: timeout 5, dns 2, http 1\)$/);

    // a quiet minute has no failures part, and the line is as it was
    monitor.recordCheck({ status: 'up', failure: null, timings: { dns: 4 } });
    const quiet = monitor.summarize();
    assert.equal(quiet.failures, null);
    assert.equal(formatSummary(quiet).includes('failed'), false);
    monitor.stop();
});
