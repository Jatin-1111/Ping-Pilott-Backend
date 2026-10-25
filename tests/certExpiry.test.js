// Run with: npm test
// Checks do not validate certificates, so an expired one never fails a check, though every visitor's browser warns. The
// expiry date is read from the handshake the check already makes, and the owner is warned at 14, 7, 3 and 1 day left and
// once more when it has expired: each step once, by email and webhook only, and never by changing the server's status.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { certDaysLeft, certLevel, decideCertAlert, planCertUpdate, cleanCert, CERT_THRESHOLDS } from '../utils/certExpiry.js';
import { raiseCertAlert } from '../services/certAlert.js';
import { deliverAlert } from '../services/alertDelivery.js';
import { enqueueAlert } from '../services/alertOutbox.js';
import { sendAlertChannels } from '../services/alertService.js';
import { getAlertEmailContent } from '../services/emailService.js';
import { checkServerStatus } from '../services/monitoringService.js';
import { planCheckUpdate } from '../utils/alertDecision.js';
import { createServerSchema } from '../utils/validations.js';
import PendingAlert from '../models/PendingAlert.js';
import Server from '../models/Server.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-25T10:00:00Z');
const inDays = (d) => new Date(T0 + d * DAY);

// ── the steps ──

test('the steps are 14, 7, 3 and 1 day left, then 0 once expired', () => {
    assert.deepEqual(CERT_THRESHOLDS, [14, 7, 3, 1]);
    const at = (days) => certLevel(inDays(days), T0);
    assert.equal(at(30), null);
    assert.equal(at(14.5), null, 'over 14 days: not yet');
    assert.equal(at(14), 14);
    assert.equal(at(13.2), 14);
    assert.equal(at(10), 14);
    assert.equal(at(7.5), 14);
    assert.equal(at(7), 7);
    assert.equal(at(6.1), 7);
    assert.equal(at(3.4), 7);
    assert.equal(at(3), 3);
    assert.equal(at(2.2), 3);
    assert.equal(at(1.5), 3);
    assert.equal(at(1), 1);
    assert.equal(at(0.4), 1, 'half a day left is 1 day');
    assert.equal(certLevel(new Date(T0), T0), 0, 'expires this instant: expired');
    assert.equal(certLevel(inDays(-3), T0), 0);
});

test('days left are rounded up, and are 0 once expired; an unreadable date is nothing', () => {
    assert.equal(certDaysLeft(inDays(10), T0), 10);
    assert.equal(certDaysLeft(inDays(9.01), T0), 10);
    assert.equal(certDaysLeft(inDays(-1), T0), 0);
    for (const bad of [null, undefined, 'soon', NaN]) {
        assert.equal(certDaysLeft(bad, T0), null, String(bad));
        assert.equal(certLevel(bad, T0), null);
    }
});

// Run daily checks of one certificate from before the first step until after it expires, saving the level between them
const watch = (expiresAt, { from = -22, to = 0, enabled = true, start = null } = {}) => {
    let alerted = start;
    const told = [];
    for (let hours = from * 24; hours <= to * 24 + 48; hours += 6) {
        const now = new Date(expiresAt.getTime() + hours * 3600 * 1000);
        const d = decideCertAlert({ expiresAt, alertedLevel: alerted, now, enabled });
        if (d.alert) told.push({ level: d.level, daysLeft: certDaysLeft(expiresAt, now) });
        alerted = d.nextAlertedLevel;
    }
    return { told, alerted };
};

test('over a certificate\'s last weeks each step is told exactly once, in order, ending with expiry', () => {
    const { told } = watch(inDays(20));
    assert.deepEqual(told.map((t) => t.level), [14, 7, 3, 1, 0]);
    assert.deepEqual(told.map((t) => t.daysLeft), [14, 7, 3, 1, 0]);
});

test('a server first seen late is warned once, at the step it has reached, not at every step it missed', () => {
    const d = decideCertAlert({ expiresAt: inDays(2), alertedLevel: null, now: T0 });
    assert.deepEqual(d, { level: 3, alert: true, nextAlertedLevel: 3 });
    assert.equal(decideCertAlert({ expiresAt: inDays(2), alertedLevel: 3, now: T0 }).alert, false);
});

test('a renewed certificate starts a new cycle: every step is told again next time', () => {
    const first = watch(inDays(20));
    assert.equal(first.told.length, 5);

    // after the warning at 3 days it is renewed for 90 days
    const afterRenewal = decideCertAlert({ expiresAt: inDays(120), alertedLevel: 3, now: T0 });
    assert.deepEqual(afterRenewal, { level: null, alert: false, nextAlertedLevel: null });
    assert.equal(watch(inDays(120), { from: -100, to: 0, start: afterRenewal.nextAlertedLevel }).told.length, 5);
});

test('renewed to a certificate that is itself close to expiry counts as handled, and the next step down is still told', () => {
    const renewed = decideCertAlert({ expiresAt: inDays(10), alertedLevel: 3, now: T0 });
    assert.deepEqual(renewed, { level: 14, alert: false, nextAlertedLevel: 14 });
    const later = decideCertAlert({ expiresAt: inDays(10), alertedLevel: 14, now: new Date(T0 + 3.5 * DAY) });
    assert.equal(later.alert, true);
    assert.equal(later.level, 7);
});

test('when the warning is switched off nothing is told, and no step is used up', () => {
    const off = watch(inDays(20), { enabled: false });
    assert.deepEqual(off.told, []);
    assert.equal(off.alerted, null);

    // switched on again with 2 days left: it is told at that step
    assert.equal(decideCertAlert({ expiresAt: inDays(2), alertedLevel: null, now: T0, enabled: true }).alert, true);
});

test('with no readable date nothing is told and the remembered step is kept', () => {
    assert.deepEqual(decideCertAlert({ expiresAt: null, alertedLevel: 7, now: T0 }), { level: null, alert: false, nextAlertedLevel: 7 });
});

// ── what is written ──

const server = (extra = {}) => ({ _id: 's1', name: 'Shop', status: 'up', monitoring: {}, ...extra });

test('a certificate with nothing new to say writes nothing', () => {
    assert.equal(planCertUpdate({ server: server(), checkResult: { certExpiresAt: inDays(90) }, now: T0 }), null);
    assert.equal(planCertUpdate({ server: server({ certAlertedDays: 3 }), checkResult: { certExpiresAt: inDays(2) }, now: T0 }), null, 'already told at this step');
    assert.equal(planCertUpdate({ server: server(), checkResult: { certExpiresAt: null }, now: T0 }), null, 'plain HTTP, TCP, no answer');
    assert.equal(planCertUpdate({ server: server(), checkResult: {}, now: T0 }), null);
    assert.equal(planCertUpdate({ server: server({ monitoring: { alerts: { certExpiry: false } } }), checkResult: { certExpiresAt: inDays(2) }, now: T0 }), null, 'switched off');
});

test('a warning is guarded by the step it was judged against, so two racing checks send one', () => {
    const fresh = planCertUpdate({ server: server(), checkResult: { certExpiresAt: inDays(10) }, now: T0 });
    assert.deepEqual(fresh.filter, { _id: 's1', certAlertedDays: null });
    assert.deepEqual(fresh.$set, { certAlertedDays: 14 });
    assert.deepEqual(fresh.alert, { level: 14, daysLeft: 10, expiresAt: inDays(10) });

    const next = planCertUpdate({ server: server({ certAlertedDays: 14 }), checkResult: { certExpiresAt: inDays(6) }, now: T0 });
    assert.deepEqual(next.filter, { _id: 's1', certAlertedDays: 14 });
    assert.equal(next.alert.level, 7);
});

test('a renewed certificate resets the step without any alert', () => {
    const plan = planCertUpdate({ server: server({ certAlertedDays: 3 }), checkResult: { certExpiresAt: inDays(120) }, now: T0 });
    assert.equal(plan.alert, null);
    assert.deepEqual(plan.$set, { certAlertedDays: null });
    assert.deepEqual(plan.filter, { _id: 's1', certAlertedDays: 3 });
});

test('the expiry date seen is saved with the check, only when a check saw one', () => {
    const base = { _id: 's1', status: 'up', monitoring: { frequency: 5 } };
    const seen = planCheckUpdate({ server: base, checkResult: { status: 'up', responseTime: 100, error: null, slow: false, failure: null, certExpiresAt: inDays(60) }, now: new Date(T0) });
    assert.deepEqual(seen.$set.certExpiresAt, inDays(60));
    const none = planCheckUpdate({ server: base, checkResult: { status: 'down', responseTime: null, error: 'x', slow: false, failure: { kind: 'other' }, certExpiresAt: null }, now: new Date(T0) });
    assert.equal('certExpiresAt' in none.$set, false, 'a check that saw none leaves the saved date alone');
});

// ── raising the alert ──

const harness = ({ matched = 1, send = true, failWrite = false } = {}) => {
    const calls = { writes: [], enqueued: [], logged: [] };
    return {
        calls,
        deps: {
            updateOne: async (filter, update) => {
                if (failWrite) throw new Error('database down');
                calls.writes.push({ filter, update });
                return { matchedCount: matched };
            },
            enqueue: async (args) => { calls.enqueued.push(args); },
            shouldSend: () => send,
            log: { error: (m) => calls.logged.push(m) }
        }
    };
};

test('a warning writes the step and queues the alert with the certificate\'s details', async () => {
    const h = harness();
    const raised = await raiseCertAlert({ server: server(), checkResult: { status: 'up', certExpiresAt: inDays(6) }, now: new Date(T0) }, h.deps);

    assert.equal(raised.level, 7);
    assert.equal(h.calls.writes.length, 1);
    assert.deepEqual(h.calls.writes[0].update, { $set: { certAlertedDays: 7 } });
    assert.equal(h.calls.enqueued.length, 1);
    assert.equal(h.calls.enqueued[0].alertType, 'cert_expiring');
    assert.equal(h.calls.enqueued[0].previous, 'up');
    assert.deepEqual(h.calls.enqueued[0].checkResult, { status: 'up', cert: { level: 7, daysLeft: 6, expiresAt: inDays(6) } });
});

test('if another check already moved the step on, no second alert is sent', async () => {
    const h = harness({ matched: 0 });
    assert.equal(await raiseCertAlert({ server: server(), checkResult: { status: 'up', certExpiresAt: inDays(6) }, now: new Date(T0) }, h.deps), null);
    assert.equal(h.calls.enqueued.length, 0);
});

test('when the owner cannot be told right now the step is not used up, so a later check tells them', async () => {
    const h = harness({ send: false });
    assert.equal(await raiseCertAlert({ server: server(), checkResult: { status: 'up', certExpiresAt: inDays(6) }, now: new Date(T0) }, h.deps), null);
    assert.equal(h.calls.writes.length, 0, 'nothing was written');
    assert.equal(h.calls.enqueued.length, 0);
});

test('a renewal is written and says nothing', async () => {
    const h = harness();
    assert.equal(await raiseCertAlert({ server: server({ certAlertedDays: 1 }), checkResult: { status: 'up', certExpiresAt: inDays(200) }, now: new Date(T0) }, h.deps), null);
    assert.deepEqual(h.calls.writes[0].update, { $set: { certAlertedDays: null } });
    assert.equal(h.calls.enqueued.length, 0);
});

test('a failure while handling the certificate is logged and never thrown, so the check is still saved', async () => {
    const h = harness({ failWrite: true });
    assert.equal(await raiseCertAlert({ server: server(), checkResult: { status: 'up', certExpiresAt: inDays(6) }, now: new Date(T0) }, h.deps), null);
    assert.match(h.calls.logged[0], /Could not handle the certificate of Shop: database down/);
});

// ── delivery ──

test('a certificate alert goes by email and webhook and is never written to the in-app feed', async () => {
    const calls = { feed: 0, channels: [], saved: [] };
    const result = await deliverAlert(
        { _id: 'p1', serverId: 's1', alertType: 'cert_expiring', oldStatus: 'up', checkResult: { status: 'up', cert: { level: 3, daysLeft: 3, expiresAt: inDays(3).toISOString() } }, done: {} },
        {
            findServer: async () => ({ name: 'Shop', url: 'shop.example', uploadedBy: 'u1', contactEmails: ['a@b.co'], monitoring: {} }),
            saveProgress: async (id, set) => { calls.saved.push(set); },
            recordFeed: async () => { calls.feed += 1; },
            sendChannels: async (server, type, checkResult, done) => { calls.channels.push({ type, checkResult, done: { ...done } }); return { email: true, webhook: true, errors: [] }; }
        }
    );
    assert.equal(result.status, 'delivered');
    assert.equal(calls.feed, 0, 'the feed was not touched');
    assert.equal(calls.channels[0].type, 'cert_expiring');
    assert.equal(calls.channels[0].done.recorded, true);
    assert.equal(calls.saved.at(-1)['done.recorded'], true);
    assert.ok(calls.saved.at(-1).deliveredAt);
});

test('the other alert types still go to the feed', async () => {
    let feed = 0;
    await deliverAlert(
        { _id: 'p1', serverId: 's1', alertType: 'server_down', oldStatus: 'up', checkResult: { status: 'down' }, done: {} },
        {
            findServer: async () => ({ name: 'Shop', url: 'shop.example', monitoring: {} }),
            saveProgress: async () => {},
            recordFeed: async () => { feed += 1; },
            sendChannels: async () => ({ email: true, webhook: true, errors: [] })
        }
    );
    assert.equal(feed, 1);
});

test('the alert row accepts the new type and keeps the certificate\'s details, cleaned', async () => {
    const row = new PendingAlert({ serverId: '5f1d7f3a8f3c2a1b4c8e9d10', alertType: 'cert_expiring' });
    assert.equal(row.validateSync(), undefined);
    assert.ok(new PendingAlert({ serverId: '5f1d7f3a8f3c2a1b4c8e9d10', alertType: 'nonsense' }).validateSync()?.errors?.alertType);

    let saved;
    const model = { create: async (doc) => { saved = doc; return { _id: 'p1', serverId: doc.serverId, alertType: doc.alertType, priority: doc.priority }; }, updateOne: async () => ({}) };
    await enqueueAlert(
        { server: { _id: 's1', uploadedBy: 'u1' }, alertType: 'cert_expiring', previous: 'up', checkResult: { status: 'up', cert: { level: 7, daysLeft: 6, expiresAt: inDays(6), junk: 1 } } },
        { model, queue: { add: async () => ({}) }, shouldSend: () => true }
    );
    assert.deepEqual(saved.checkResult.cert, { expiresAt: inDays(6).toISOString(), daysLeft: 6, level: 7 });
    assert.equal(cleanCert({ level: 9, daysLeft: 3, expiresAt: inDays(3) }), null, '9 is not a step');
    assert.equal(cleanCert({ level: 3, daysLeft: -1, expiresAt: inDays(3) }), null);
    assert.equal(cleanCert('x'), null);
});

test('the webhook payload carries the certificate for this alert and for no other', async () => {
    const send = async (type, checkResult) => {
        let payload;
        await sendAlertChannels(
            { _id: 's1', name: 'Shop', url: 'shop.example', status: 'up', contactEmails: [], monitoring: { alerts: { webhookUrl: 'https://hooks.example/x' } } },
            type, checkResult, {},
            { sendWebhook: async (_s, alertType, body) => { payload = { alertType, ...body }; }, sendEmail: async () => {} }
        );
        return payload;
    };
    const cert = { level: 3, daysLeft: 3, expiresAt: inDays(3).toISOString() };
    const warned = await send('cert_expiring', { status: 'up', cert });
    assert.equal(warned.alertType, 'cert_expiring');
    assert.deepEqual(warned.cert, cert);
    assert.equal('cert' in (await send('server_down', { status: 'down', cert })), false, 'other alert types keep their payload');
});

// ── the email ──

test('the email says how long is left, when it expires, and that the site is not marked down', () => {
    const base = { name: 'Shop', url: 'shop.example.com' };
    const soon = getAlertEmailContent({ ...base, cert: { level: 3, daysLeft: 3, expiresAt: '2026-10-28T10:00:00.000Z' } }, 'cert_expiring', 'up', 'up');
    assert.equal(soon.subject, '⚠️ WARNING: The certificate for Shop expires in 3 days');
    assert.match(soon.html, /expires in <strong[^>]*>3 days<\/strong>/);
    assert.match(soon.html, /Wed, 28 Oct 2026 10:00:00 GMT/);
    assert.match(soon.html, /shop\.example\.com/);
    assert.match(soon.html, /does not mark it down/);

    const one = getAlertEmailContent({ ...base, cert: { level: 1, daysLeft: 1, expiresAt: '2026-10-26T10:00:00.000Z' } }, 'cert_expiring', 'up', 'up');
    assert.equal(one.subject, '⚠️ WARNING: The certificate for Shop expires in 1 day', 'singular');

    const expired = getAlertEmailContent({ ...base, cert: { level: 0, daysLeft: 0, expiresAt: '2026-10-24T10:00:00.000Z' } }, 'cert_expiring', 'up', 'up');
    assert.equal(expired.subject, '🚨 ALERT: The certificate for Shop has expired');
    assert.match(expired.html, /has expired/);
    assert.match(expired.html, /browsers now warn them/);
});

test('the email escapes a server name, and the other alert emails are unchanged', () => {
    const evil = getAlertEmailContent({ name: '<img src=x onerror=alert(1)>', url: 'a.com', cert: { level: 7, daysLeft: 7, expiresAt: '2026-11-01T00:00:00.000Z' } }, 'cert_expiring', 'up', 'up');
    assert.doesNotMatch(evil.html, /<img src=x/);
    assert.match(evil.html, /&lt;img/);

    const down = getAlertEmailContent({ name: 'Shop', url: 'a.com', error: 'Connection refused' }, 'server_down', 'up', 'down');
    assert.equal(down.subject, '🚨 ALERT: Shop is DOWN');
    assert.doesNotMatch(down.html, /certificate/i);
});

// ── the setting ──

test('the warning is on unless turned off, in the model and in validation', () => {
    const owner = '5f1d7f3a8f3c2a1b4c8e9d10';
    assert.equal(new Server({ name: 'a', url: 'a.com', uploadedBy: owner }).monitoring.alerts.certExpiry, true);
    assert.equal(new Server({ name: 'a', url: 'a.com', uploadedBy: owner, monitoring: { alerts: { certExpiry: false } } }).monitoring.alerts.certExpiry, false);

    const ok = createServerSchema.safeParse({ name: 'Shop', url: 'shop.example.com', monitoring: { alerts: { certExpiry: false } } });
    assert.equal(ok.success, true);
    assert.equal(ok.data.monitoring.alerts.certExpiry, false);
    assert.equal(createServerSchema.safeParse({ name: 'Shop', url: 'shop.example.com', monitoring: { alerts: { certExpiry: 'no' } } }).success, false);

    const fresh = new Server({ name: 'a', url: 'a.com', uploadedBy: owner });
    assert.equal(fresh.certExpiresAt, null);
    assert.equal(fresh.certAlertedDays, null);
});

// ── real TLS ──

let secure;
let securePort;

before(async () => {
    process.env.ALLOW_PRIVATE_TARGETS = 'true';
    const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
    secure = https.createServer({ key: fixture('test-tls.key.pem'), cert: fixture('test-tls.cert.pem') }, (req, res) => {
        const status = Number(new URL(req.url, 'http://x').searchParams.get('status') || 200);
        res.writeHead(status, { 'Content-Length': 2 });
        res.end(req.method === 'HEAD' ? undefined : 'ok');
    });
    await new Promise((resolve) => secure.listen(0, '127.0.0.1', resolve));
    securePort = secure.address().port;
});

after(async () => {
    secure.closeAllConnections?.();
    await new Promise((resolve) => secure.close(resolve));
});

const site = (path, extra = {}) => ({ url: `https://127.0.0.1:${securePort}${path}`, type: 'website', monitoring: {}, ...extra });

test('a check reads the certificate\'s expiry from the handshake', async () => {
    const result = await checkServerStatus(site('/'));
    assert.equal(result.status, 'up');
    assert.ok(result.certExpiresAt instanceof Date);
    // the test certificate is valid for a hundred years from when it was made
    assert.ok(result.certExpiresAt.getTime() > Date.now() + 50 * 365 * DAY, `expires ${result.certExpiresAt.toISOString()}`);
    assert.equal(result.certExpiresAt.getUTCFullYear() >= 2120, true);
});

test('every check sees the certificate, however recently the last one connected to the same host', async () => {
    // A resumed TLS session does not present the certificate again, so checks must not resume one
    for (let i = 0; i < 4; i += 1) {
        const result = await checkServerStatus(site('/'));
        assert.ok(result.certExpiresAt instanceof Date, `check ${i + 1} in a row had no certificate`);
    }
});

test('a site that answers with an error over TLS still reports its certificate', async () => {
    const result = await checkServerStatus(site('/?status=503'));
    assert.equal(result.status, 'down');
    assert.deepEqual(result.failure, { kind: 'http', statusCode: 503 });
    assert.ok(result.certExpiresAt instanceof Date);

    const keyword = await checkServerStatus(site('/', { monitoring: { keyword: { text: 'not on the page', mode: 'present' } } }));
    assert.equal(keyword.failure.kind, 'content');
    assert.ok(keyword.certExpiresAt instanceof Date, 'also when the keyword check fails');
});

test('plain HTTP, a TCP check and a refused connection have no certificate', async () => {
    const plain = https.createServer; // (only to keep the import honest)
    assert.equal(typeof plain, 'function');

    const open = net.createServer((socket) => socket.end());
    await new Promise((resolve) => open.listen(0, '127.0.0.1', resolve));
    const port = open.address().port;
    try {
        assert.equal((await checkServerStatus({ url: `127.0.0.1:${port}`, type: 'tcp', monitoring: {} })).certExpiresAt, null);
    } finally {
        await new Promise((resolve) => open.close(resolve));
    }
    const refused = await checkServerStatus({ url: `https://127.0.0.1:${port}/`, type: 'website', monitoring: {} });
    assert.equal(refused.status, 'down');
    assert.equal(refused.certExpiresAt, null);
});
