// Run with: npm test
// Regression for F1: an alert used to be one Redis job with 3 attempts over 6 seconds. A queue that was down when the
// status changed, or an email provider that was down for half a minute, lost the alert for good (the server is
// already saved as down, and down -> down never alerts again).
// No database, Redis or SMTP is needed: models, queue and senders are replaced by fakes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueAlert, requeueUndelivered, REQUEUE_AFTER_MS, GIVE_UP_AFTER_MS } from '../services/alertOutbox.js';
import { deliverAlert } from '../services/alertDelivery.js';
import { sendAlertChannels, isPermanentWebhookFailure } from '../services/alertService.js';
import { ALERT_JOB_OPTIONS, ALERT_ATTEMPTS, retryWindowMs } from '../queues/alertJobOptions.js';

const SERVER_ID = '65f000000000000000000001';
const USER_ID = '65f000000000000000000002';

const server = (extra = {}) => ({ _id: SERVER_ID, name: 'Shop', uploadedBy: USER_ID, priority: 'medium', ...extra });
const down = { status: 'down', responseTime: null, error: 'Connection refused', slow: false };

// A model that remembers calls; `find` answers are set by the test
const fakeModel = (answers = {}) => {
    const calls = { create: [], updateOne: [], updateMany: [], findOneAndUpdate: [] };
    const chain = (rows) => ({ select: () => chain(rows), limit: () => chain(rows), lean: async () => rows });
    let findCall = 0;
    return {
        calls,
        async create(doc) {
            if (answers.createError) throw answers.createError;
            calls.create.push(doc);
            return { _id: 'row1', ...doc };
        },
        async updateOne(...args) { calls.updateOne.push(args); return {}; },
        async updateMany(...args) { calls.updateMany.push(args); return {}; },
        find() { const rows = (answers.finds || [])[findCall] || []; findCall += 1; return chain(rows); },
        findOneAndUpdate(...args) {
            calls.findOneAndUpdate.push(args);
            return { lean: async () => (answers.claim === undefined ? { ...args[0], ...{ requeues: 1 }, priority: 'normal', serverId: SERVER_ID, _id: args[0]._id } : answers.claim) };
        },
    };
};

const fakeQueue = (fail = false) => {
    const added = [];
    return { added, add: async (data, priority, jobId) => { if (fail) throw new Error('Redis is down'); added.push({ data, priority, jobId }); } };
};

// --- retry window ---

test('an alert job retries over minutes, not seconds', () => {
    assert.equal(ALERT_JOB_OPTIONS.backoff.type, 'exponential');
    assert.ok(ALERT_ATTEMPTS >= 5);
    assert.ok(retryWindowMs() >= 3 * 60 * 1000, `window is ${retryWindowMs()}ms`);
    // the old settings: 3 attempts, 2 s base -> 2 s + 4 s
    assert.equal(retryWindowMs(3, 2000), 6000);
});

// --- enqueueAlert ---

test('a status change is saved as a pending alert, then queued under a job id that cannot be queued twice', async () => {
    const model = fakeModel();
    const queue = fakeQueue();
    const row = await enqueueAlert({ server: server({ priority: 'high' }), alertType: 'server_down', previous: 'up', checkResult: down }, { model, queue, shouldSend: () => true });

    assert.ok(row);
    assert.equal(model.calls.create.length, 1);
    assert.equal(model.calls.create[0].alertType, 'server_down');
    assert.equal(model.calls.create[0].oldStatus, 'up');
    assert.equal(model.calls.create[0].priority, 'high');
    assert.equal(queue.added.length, 1);
    assert.equal(queue.added[0].jobId, 'alert-row1');
    assert.equal(queue.added[0].data.pendingId, 'row1');
    assert.ok(model.calls.updateOne[0][1].$set.lastQueuedAt instanceof Date, 'the row records that it was queued');
});

test('when the queue is down the alert stays saved and never-queued, and nothing throws', async () => {
    const model = fakeModel();
    const row = await enqueueAlert({ server: server(), alertType: 'server_down', previous: 'up', checkResult: down }, { model, queue: fakeQueue(true), shouldSend: () => true });

    assert.ok(row, 'the alert was saved');
    assert.equal(model.calls.create.length, 1);
    assert.equal(model.calls.updateOne.length, 0, 'lastQueuedAt stays null so the reconciler finds it');
});

test('nothing is saved when the owner has alerts off or is outside their alert hours', async () => {
    const model = fakeModel();
    const queue = fakeQueue();
    const row = await enqueueAlert({ server: server(), alertType: 'server_down', previous: 'up', checkResult: down }, { model, queue, shouldSend: () => false });
    assert.equal(row, null);
    assert.equal(model.calls.create.length, 0);
    assert.equal(queue.added.length, 0);
});

test('a database failure while saving the alert never reaches the check that triggered it', async () => {
    const model = fakeModel({ createError: new Error('connection lost') });
    const row = await enqueueAlert({ server: server(), alertType: 'server_down', previous: 'up', checkResult: down }, { model, queue: fakeQueue(), shouldSend: () => true });
    assert.equal(row, null);
});

// --- requeueUndelivered ---

test('an alert that was never queued, or whose job is long finished, is queued again under a new job id', async () => {
    const stale = { _id: 'a1', serverId: SERVER_ID, priority: 'normal', lastQueuedAt: new Date(0) };
    const model = fakeModel({ finds: [[], [stale]] });
    const queue = fakeQueue();

    const result = await requeueUndelivered({ model, queue, now: new Date('2026-10-24T12:00:00Z') });

    assert.deepEqual(result, { requeued: 1, abandoned: 0 });
    assert.equal(queue.added[0].jobId, 'alert-a1-1', 'a new id, so the old finished job does not make the add a no-op');
    assert.equal(model.calls.findOneAndUpdate[0][1].$inc.requeues, 1);
});

test('an alert another scheduler process just claimed is left alone', async () => {
    const model = fakeModel({ finds: [[], [{ _id: 'a1', serverId: SERVER_ID, lastQueuedAt: null }]], claim: null });
    const queue = fakeQueue();
    const result = await requeueUndelivered({ model, queue });
    assert.equal(result.requeued, 0);
    assert.equal(queue.added.length, 0);
});

test('if re-queueing fails the claim is put back so the next run tries again', async () => {
    const original = new Date(0);
    const model = fakeModel({ finds: [[], [{ _id: 'a1', serverId: SERVER_ID, lastQueuedAt: original }]] });
    const result = await requeueUndelivered({ model, queue: fakeQueue(true) });
    assert.equal(result.requeued, 0);
    assert.equal(model.calls.updateOne.at(-1)[1].$set.lastQueuedAt, original);
});

test('alerts still undelivered after 24 hours are abandoned, not retried for ever', async () => {
    const old = { _id: 'old1', serverId: SERVER_ID, alertType: 'server_down', lastError: 'SMTP refused' };
    const model = fakeModel({ finds: [[old], []] });
    const now = new Date('2026-10-24T12:00:00Z');

    const result = await requeueUndelivered({ model, queue: fakeQueue(), now });

    assert.deepEqual(result, { requeued: 0, abandoned: 1 });
    assert.deepEqual(model.calls.updateMany[0][0], { _id: { $in: ['old1'] } });
    assert.equal(model.calls.updateMany[0][1].$set.abandonedAt, now);
    assert.ok(GIVE_UP_AFTER_MS > REQUEUE_AFTER_MS);
});

// --- sendAlertChannels ---

const withContacts = { monitoring: { alerts: { email: true, webhookUrl: 'https://hooks.example.com/x' } }, contactEmails: ['a@example.com'], status: 'up' };

test('a webhook that fails does not stop the email, and the email is reported as sent', async () => {
    const sent = [];
    const result = await sendAlertChannels(withContacts, 'server_down', down, {}, {
        sendEmail: async () => { sent.push('email'); },
        sendWebhook: async () => { throw new Error('socket hang up'); },
    });
    assert.deepEqual(sent, ['email']);
    assert.equal(result.email, true);
    assert.equal(result.webhook, false);
    assert.equal(result.errors.length, 1);
});

test('a retry sends only the channel that is still missing', async () => {
    const sent = [];
    const result = await sendAlertChannels(withContacts, 'server_down', down, { email: true, webhook: false }, {
        sendEmail: async () => { sent.push('email'); },
        sendWebhook: async () => { sent.push('webhook'); },
    });
    assert.deepEqual(sent, ['webhook']);
    assert.deepEqual([result.email, result.webhook, result.errors.length], [true, true, 0]);
});

test('a channel with nothing to send counts as done', async () => {
    const result = await sendAlertChannels({ monitoring: { alerts: {} }, contactEmails: [], status: 'up' }, 'server_down', down, {}, {
        sendEmail: async () => { throw new Error('must not be called'); },
        sendWebhook: async () => { throw new Error('must not be called'); },
    });
    assert.deepEqual([result.email, result.webhook, result.errors.length], [true, true, 0]);
});

test('an email failure is reported, not thrown, so the other channel still goes out', async () => {
    const result = await sendAlertChannels(withContacts, 'server_down', down, {}, {
        sendEmail: async () => { throw new Error('SMTP timeout'); },
        sendWebhook: async () => {},
    });
    assert.deepEqual([result.email, result.webhook], [false, true]);
    assert.equal(result.errors[0].message, 'SMTP timeout');
});

test('a webhook the receiver refuses (404) is given up on, a server error (500) or timeout is retried', async () => {
    const failing = (error) => sendAlertChannels(withContacts, 'server_down', down, { email: true }, { sendWebhook: async () => { throw error; } });
    const http = (status) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });

    assert.equal((await failing(http(404))).webhook, true);
    assert.equal((await failing(http(403))).webhook, true);
    assert.equal((await failing(http(500))).webhook, false);
    assert.equal((await failing(http(429))).webhook, false);
    assert.equal((await failing(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }))).webhook, false);
    assert.equal(isPermanentWebhookFailure(Object.assign(new Error('private'), { code: 'PRIVATE_TARGET' })), true);
});

// --- deliverAlert ---

const pendingRow = (extra = {}) => ({ _id: 'p1', serverId: SERVER_ID, alertType: 'server_down', oldStatus: 'up', newStatus: 'down', checkResult: down, done: {}, ...extra });

const makeDeps = ({ email = true, webhook = true, feed = true, serverGone = false } = {}) => {
    const saved = [];
    const feedRows = [];
    const sends = [];
    return {
        saved, feedRows, sends,
        findServer: async () => (serverGone ? null : server({ monitoring: { alerts: {} } })),
        saveProgress: async (id, set) => { saved.push(set); },
        recordFeed: async (pending) => { if (!feed) throw new Error('mongo write failed'); feedRows.push(pending._id); },
        sendChannels: async (srv, type, result, done) => {
            sends.push({ ...done });
            const errors = [];
            const out = { email: done.email, webhook: done.webhook, errors };
            if (!out.email) { if (email) out.email = true; else errors.push(new Error('SMTP timeout')); }
            if (!out.webhook) { if (webhook) out.webhook = true; else errors.push(new Error('webhook 502')); }
            return out;
        },
    };
};

test('everything succeeds: the alert is marked delivered once', async () => {
    const deps = makeDeps();
    const result = await deliverAlert(pendingRow(), deps);
    assert.equal(result.status, 'delivered');
    assert.ok(deps.saved[0].deliveredAt instanceof Date);
    assert.equal(deps.saved[0].lastError, null);
    assert.deepEqual(deps.feedRows, ['p1']);
});

test('email failing: the job throws so the queue retries, the feed row is still written, and progress is saved', async () => {
    const deps = makeDeps({ email: false });
    await assert.rejects(() => deliverAlert(pendingRow(), deps), /not fully delivered.*email pending.*SMTP timeout/s);
    assert.equal(deps.saved[0]['done.recorded'], true);
    assert.equal(deps.saved[0]['done.email'], false);
    assert.equal(deps.saved[0]['done.webhook'], true);
    assert.equal(deps.saved[0].deliveredAt, undefined);
    assert.match(deps.saved[0].lastError, /SMTP timeout/);
});

test('a retry after an email outage repeats only the email, and the feed row is not written twice', async () => {
    const first = makeDeps({ email: false });
    await assert.rejects(() => deliverAlert(pendingRow(), first));

    const second = makeDeps();
    const progress = first.saved[0];
    const retry = pendingRow({ done: { recorded: progress['done.recorded'], email: progress['done.email'], webhook: progress['done.webhook'] } });
    const result = await deliverAlert(retry, second);

    assert.equal(result.status, 'delivered');
    assert.deepEqual(second.sends[0], { recorded: true, email: false, webhook: true }, 'the webhook is not sent again');
    assert.deepEqual(second.feedRows, [], 'the feed row already exists');
});

test('if the feed row cannot be written the alert still goes out by email, and is retried for the feed', async () => {
    const deps = makeDeps({ feed: false });
    await assert.rejects(() => deliverAlert(pendingRow(), deps), /feed pending/);
    assert.equal(deps.sends.length, 1, 'email and webhook were still attempted');
    assert.equal(deps.saved[0]['done.email'], true);
    assert.equal(deps.saved[0]['done.recorded'], false);
});

test('an alert for a server that has since been deleted is dropped, not retried', async () => {
    const deps = makeDeps({ serverGone: true });
    const result = await deliverAlert(pendingRow(), deps);
    assert.equal(result.status, 'dropped');
    assert.ok(deps.saved[0].deliveredAt instanceof Date);
    assert.equal(deps.sends.length, 0);
});

test('the server is described with the status it moved away from', async () => {
    let seen;
    const deps = makeDeps();
    deps.sendChannels = async (srv, type, result, done) => { seen = srv; return { email: true, webhook: true, errors: [] }; };
    await deliverAlert(pendingRow({ oldStatus: 'up' }), deps);
    assert.equal(seen.status, 'up');
    assert.equal(String(seen._id), SERVER_ID);
});
