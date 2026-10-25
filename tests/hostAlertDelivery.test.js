// Run with: npm test
// How a host alert reaches people: the pending record, the webhook, the chat message, the email, the app's feed, and the
// settings that decide when it fires. The older apps must never be sent a type they cannot show.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { enqueueAlert } from '../services/alertOutbox.js';
import { sendAlertChannels } from '../services/alertService.js';
import { chatRequest, describeAlert } from '../utils/chatWebhook.js';
import { getAlertEmailContent } from '../services/emailService.js';
import { buildAlertMessage, toAlertItem, parseAlertQuery, feedTypes, CLASSIC_TYPES, HOST_TYPES } from '../utils/alertFeed.js';
import { deliverAlert } from '../services/alertDelivery.js';
import { HOST_ALERT_TYPES } from '../utils/hostAlerts.js';
import { buildMonitoringUpdates } from '../utils/monitoringSettings.js';
import { updateServerSchema } from '../utils/validations.js';
import PendingAlert from '../models/PendingAlert.js';
import AlertEvent from '../models/AlertEvent.js';
import Server from '../models/Server.js';
import { getAlerts } from '../controllers/alertController.js';

const cpuEvent = { metric: 'cpu', type: 'host_cpu_high', recovered: false, value: 97, threshold: 90, minutes: 5, procs: [{ name: 'node', cpu: 85, mem: 2 }] };
const diskEnd = { metric: 'disk', type: 'host_disk_high', recovered: true, value: 80, threshold: 90, mount: '/data' };
const missing = { metric: 'missing', type: 'host_metrics_missing', recovered: false, minutes: 12, lastSeen: '2026-10-26T12:03:00Z', alsoDown: true };
const server = { _id: 's1', name: 'Shop', url: 'https://shop.example', status: 'up', contactEmails: ['a@example.com'], monitoring: { alerts: { enabled: true, email: true, webhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXX' } } };

// ── the type lists agree ──

test('the alert types are the same everywhere they are listed', () => {
    assert.deepEqual(HOST_TYPES, HOST_ALERT_TYPES);
    for (const model of [PendingAlert.schema.path('alertType'), AlertEvent.schema.path('type')]) {
        for (const type of [...CLASSIC_TYPES, ...HOST_TYPES]) assert.ok(model.enumValues.includes(type), type);
    }
    assert.ok(PendingAlert.schema.path('alertType').enumValues.includes('cert_expiring'));
    assert.ok(!AlertEvent.schema.path('type').enumValues.includes('cert_expiring'), 'still not in the feed');
});

// ── recorded for delivery ──

test('a host alert is kept with its numbers for delivery, cleaned', async () => {
    const created = [];
    const model = { create: async (doc) => { created.push(doc); return { _id: 'p1', ...doc }; }, updateOne: async () => {} };
    await enqueueAlert({
        server, alertType: 'host_cpu_high', previous: 'up',
        checkResult: { status: 'up', host: { ...cpuEvent, procs: [{ name: 'a\nb', cpu: 5, mem: 1 }], junk: 'x' } }
    }, { model, queue: { add: async () => {} }, shouldSend: () => true });
    assert.equal(created[0].alertType, 'host_cpu_high');
    assert.equal(created[0].checkResult.host.value, 97);
    assert.equal(created[0].checkResult.host.procs[0].name, 'ab');
    assert.equal('junk' in created[0].checkResult.host, false);
    assert.equal('host' in (await (async () => { const c = []; await enqueueAlert({ server, alertType: 'server_down', previous: 'up', checkResult: { status: 'down' } }, { model: { create: async (d) => { c.push(d); return { _id: 'p2', ...d }; }, updateOne: async () => {} }, queue: { add: async () => {} }, shouldSend: () => true }); return c[0].checkResult; })()), false, 'other alerts are as they were');
});

test('when the owner is not to be told now, nothing is recorded', async () => {
    const created = [];
    const model = { create: async (d) => created.push(d), updateOne: async () => {} };
    assert.equal(await enqueueAlert({ server, alertType: 'host_cpu_high', previous: 'up', checkResult: { status: 'up', host: cpuEvent } }, { model, queue: { add: async () => {} }, shouldSend: () => false }), null);
    assert.deepEqual(created, []);
});

// ── by email and webhook ──

test('the webhook carries the numbers and the sentence, and the email is sent with the host data', async () => {
    const webhooks = [];
    const emails = [];
    const result = await sendAlertChannels(server, 'host_cpu_high', { status: 'up', host: cpuEvent }, {}, {
        sendEmail: async (s, type, o, n) => emails.push({ host: s.host, type, o, n }),
        sendWebhook: async (s, type, payload) => webhooks.push({ type, payload })
    });
    assert.equal(result.email, true);
    assert.equal(result.webhook, true);
    assert.equal(emails[0].host.value, 97);
    assert.equal(webhooks[0].type, 'host_cpu_high');
    assert.equal(webhooks[0].payload.host.threshold, 90);
    assert.equal(webhooks[0].payload.message, 'CPU has been above 90% for 5 minutes (now 97%).');
});

test('the other alerts\' webhooks are exactly as they were: no host, no message of ours', async () => {
    const webhooks = [];
    await sendAlertChannels(server, 'server_down', { status: 'down', error: 'HTTP 502' }, {}, { sendEmail: async () => {}, sendWebhook: async (s, t, payload) => webhooks.push(payload) });
    assert.equal('host' in webhooks[0], false);
    assert.equal('message' in webhooks[0], false);
});

// ── chat messages ──

test('each chat app gets the title and the lines', () => {
    const { title, lines } = describeAlert('host_cpu_high', server, { host: cpuEvent });
    assert.equal(title, '⚠️ CPU on Shop is high');
    assert.ok(lines.includes('CPU has been above 90% for 5 minutes (now 97%).'));
    assert.ok(lines.some((l) => l.includes('What is using it: node')));
    assert.ok(lines.includes('https://shop.example'));

    const end = describeAlert('host_disk_high', server, { host: diskEnd });
    assert.ok(end.title.startsWith('✅'), 'an end is marked as one');
    assert.equal(describeAlert('host_metrics_missing', server, { host: missing }).title, '⚠️ No data from the agent on Shop');

    for (const url of ['https://hooks.slack.com/services/T000/B000/XXXX', 'https://discord.com/api/webhooks/123/abc']) {
        const req = chatRequest('host_cpu_high', server, { host: cpuEvent }, url);
        assert.ok(JSON.stringify(req.body).includes('CPU on Shop is high'), url);
    }
    assert.equal(describeAlert('host_cpu_high', server, {}).title, '⚠️ Shop: host alert', 'a payload with no host still says something');
});

// ── the email ──

test('the email says what the owner needs, escapes what is not ours, and looks like an end when it is one', () => {
    const e = getAlertEmailContent({ name: 'Shop <script>', url: 'https://shop.example', host: cpuEvent }, 'host_cpu_high', 'up', 'up');
    assert.match(e.subject, /WARNING: CPU on Shop <script> is high/);
    assert.ok(e.html.includes('Shop &lt;script&gt;'));
    assert.ok(!e.html.includes('<script>'));
    assert.ok(e.html.includes('What is using it: node 85% of one core'));
    assert.ok(e.html.includes('#ff9800'));

    const end = getAlertEmailContent({ name: 'Shop', url: 'u', host: diskEnd }, 'host_disk_high', 'up', 'up');
    assert.match(end.subject, /RESOLVED/);
    assert.ok(end.html.includes('#4CAF50'));

    const quiet = getAlertEmailContent({ name: 'Shop', url: 'u', host: missing }, 'host_metrics_missing', 'down', 'down');
    assert.ok(quiet.html.includes('systemctl status pingpilot-agent'));
    assert.ok(quiet.html.includes('whole machine may be off'));
});

test('a host alert with no usable host data falls back to the plain notification, never a blank email', () => {
    const e = getAlertEmailContent({ name: 'Shop', url: 'u', host: { metric: 'gpu' } }, 'host_cpu_high', 'up', 'up');
    assert.match(e.subject, /NOTIFICATION: Shop/);
});

// ── the app's feed ──

test('the feed line for each alert is the sentence, and other alerts read as before', () => {
    assert.equal(buildAlertMessage('host_cpu_high', { host: cpuEvent }, server), 'CPU has been above 90% for 5 minutes (now 97%).');
    assert.equal(buildAlertMessage('host_disk_high', { host: diskEnd }, server), 'Disk /data is back to 80% full.');
    assert.equal(buildAlertMessage('host_cpu_high', {}, server), null);
    assert.equal(buildAlertMessage('server_recovery', { responseTime: 120 }, server), 'Back online, responding in 120 ms.');
});

test('a host alert in the feed says which number it is about and whether it is an end; the others have neither', () => {
    const row = { _id: '65f000000000000000000001', serverId: 's1', serverName: 'Shop', type: 'host_disk_high', message: 'm', createdAt: new Date(), metric: 'disk', recovered: true };
    const item = toAlertItem(row);
    assert.equal(item.metric, 'disk');
    assert.equal(item.recovered, true);
    assert.equal(toAlertItem({ ...row, recovered: undefined }).recovered, false);
    const classic = toAlertItem({ ...row, type: 'server_recovery' });
    assert.equal('metric' in classic, false);
    assert.equal('recovered' in classic, false);
});

test('only an app that asks for the host types is sent them', () => {
    assert.equal(parseAlertQuery({}).includeHost, false);
    assert.equal(parseAlertQuery({ include: 'host' }).includeHost, true);
    assert.equal(parseAlertQuery({ include: 'host,other' }).includeHost, true);
    assert.equal(parseAlertQuery({ include: ' host ' }).includeHost, true, 'spaces around an item are ignored');
    assert.equal(parseAlertQuery({ include: 'hosts' }).includeHost, false);
    assert.equal(parseAlertQuery({ include: ['host'] }).includeHost, true);
    assert.deepEqual(feedTypes(false), CLASSIC_TYPES);
    assert.deepEqual(feedTypes(true), [...CLASSIC_TYPES, ...HOST_TYPES]);
});

test('the real feed handler leaves the host types out for an app that did not ask, in the list and in the unread count', async () => {
    const seen = { find: null, count: null };
    const realFind = AlertEvent.find;
    const realCount = AlertEvent.countDocuments;
    AlertEvent.find = (filter) => { seen.find = filter; return { sort: () => ({ limit: () => ({ lean: async () => [] }) }) }; };
    AlertEvent.countDocuments = async (filter) => { seen.count = filter; return 0; };
    try {
        const respond = () => { const r = { code: null, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };

        await getAlerts({ query: {}, user: { _id: 'u1' } }, respond(), () => {});
        assert.deepEqual(seen.find.type, { $in: CLASSIC_TYPES });
        assert.deepEqual(seen.count.type, { $in: CLASSIC_TYPES });
        assert.equal(seen.find.userId, 'u1');

        await getAlerts({ query: { include: 'host' }, user: { _id: 'u1' } }, respond(), () => {});
        assert.deepEqual(seen.find.type, { $in: [...CLASSIC_TYPES, ...HOST_TYPES] });
        assert.deepEqual(seen.count.type, { $in: [...CLASSIC_TYPES, ...HOST_TYPES] });
    } finally {
        AlertEvent.find = realFind;
        AlertEvent.countDocuments = realCount;
    }
});

test('pushed live, a host alert goes out on its own event, so an app that does not know it never receives one', () => {
    const socket = fs.readFileSync(new URL('../config/socket.js', import.meta.url), 'utf8');
    assert.match(socket, /HOST_TYPES\.includes\(alert\?\.type\) \? 'alert:host' : 'alert:new'/);
});

test('a host alert is recorded in the feed (unlike a certificate warning, which is not), and every channel still goes out', async () => {
    const calls = { feed: [], saved: [] };
    const deps = {
        findServer: async () => ({ ...server }),
        saveProgress: async (id, set) => calls.saved.push(set),
        recordFeed: async (p) => calls.feed.push(p.alertType),
        sendChannels: async () => ({ email: true, webhook: true, errors: [] })
    };
    await deliverAlert({ _id: 'p1', serverId: 's1', alertType: 'host_cpu_high', oldStatus: 'up', checkResult: { host: cpuEvent }, done: {} }, deps);
    assert.deepEqual(calls.feed, ['host_cpu_high']);
    await deliverAlert({ _id: 'p2', serverId: 's1', alertType: 'cert_expiring', oldStatus: 'up', checkResult: {}, done: {} }, deps);
    assert.deepEqual(calls.feed, ['host_cpu_high'], 'certificates are still not in the feed');
});

// ── the settings ──

test('the limits an owner sends are saved one number at a time, so the others keep their values', () => {
    const body = { hostAlerts: { cpu: { percent: 80 }, memory: { minutes: 10 }, disk: { percent: 95, minutes: 0 }, missing: { minutes: 15 }, enabled: false } };
    const parsed = updateServerSchema.safeParse({ monitoring: body });
    assert.equal(parsed.success, true);
    assert.deepEqual(buildMonitoringUpdates({}, parsed.data.monitoring), {
        'monitoring.hostAlerts.enabled': false,
        'monitoring.hostAlerts.cpu.percent': 80,
        'monitoring.hostAlerts.memory.minutes': 10,
        'monitoring.hostAlerts.disk.percent': 95,
        'monitoring.hostAlerts.disk.minutes': 0,
        'monitoring.hostAlerts.missing.minutes': 15
    });
    assert.deepEqual(buildMonitoringUpdates({}, { frequency: 5 }), {}, 'a save with no host limits has none in it');
});

test('a limit that is out of range, not a whole number, or not a number is refused', () => {
    const bad = [
        { cpu: { percent: 0 } }, { cpu: { percent: 101 } }, { cpu: { percent: 90.5 } }, { cpu: { percent: '90' } }, { cpu: { minutes: -1 } },
        { memory: { minutes: 61 } }, { disk: { percent: null } }, { missing: { minutes: 1 } }, { missing: { minutes: 61 } }, { enabled: 'yes' }
    ];
    for (const hostAlerts of bad) assert.equal(updateServerSchema.safeParse({ monitoring: { hostAlerts } }).success, false, JSON.stringify(hostAlerts));
    assert.equal(updateServerSchema.safeParse({ monitoring: { hostAlerts: { cpu: { percent: 100, minutes: 60 }, missing: { minutes: 2 } } } }).success, true);
});

test('the stored settings and state accept what the code writes and refuse what makes no sense', () => {
    const ok = new Server({ name: 'x', url: 'https://x.example', uploadedBy: '65f000000000000000000001', monitoring: { hostAlerts: { cpu: { percent: 80, minutes: 3 }, missing: { minutes: 10 } } }, agent: { enabled: true, alerts: { cpu: { since: 1, alerted: false } }, alertsRev: 2 } });
    assert.equal(ok.validateSync(), undefined);
    const bad = new Server({ name: 'x', url: 'https://x.example', uploadedBy: '65f000000000000000000001', monitoring: { hostAlerts: { cpu: { percent: 0 }, missing: { minutes: 1 } } } });
    const error = bad.validateSync();
    assert.ok(error.errors['monitoring.hostAlerts.cpu.percent'] && error.errors['monitoring.hostAlerts.missing.minutes']);
});

// ── the admin chart ──
import { countAlertsByKind } from '../utils/alertFeed.js';

test('the admin chart counts every kind of delivered alert, host alerts together, and ignores a type it does not know', () => {
    const counts = countAlertsByKind([
        { _id: 'server_down', value: 4 }, { _id: 'slow_response', value: 2 },
        { _id: 'host_cpu_high', value: 3 }, { _id: 'host_disk_high', value: 1 }, { _id: 'host_metrics_missing', value: 2 },
        { _id: 'something_else', value: 99 }, { _id: '__proto__', value: 5 }, { _id: null, value: 7 }, { _id: 'server_down', value: 'x' }
    ]);
    assert.deepEqual(counts, [
        { name: 'Server down', value: 4 }, { name: 'Recovered', value: 0 }, { name: 'Slow response', value: 2 }, { name: 'Host resources', value: 6 }
    ]);
    assert.deepEqual(countAlertsByKind().map((c) => c.value), [0, 0, 0, 0], 'nothing in, every kind at zero');
});
