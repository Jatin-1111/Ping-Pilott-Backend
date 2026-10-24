// Run with: npm test
// The alert feed behind the mobile app: message wording, the payload shape and the paging rules.
// No database: the controller tests swap the model's methods for fakes.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { buildAlertMessage, toAlertItem, parseAlertQuery, DEFAULT_LIMIT, MAX_LIMIT } from '../utils/alertFeed.js';
import AlertEvent from '../models/AlertEvent.js';
import { getAlerts, markAlertRead, markAllAlertsRead } from '../controllers/alertController.js';

const ID_A = '65f000000000000000000001';
const ID_B = '65f000000000000000000002';
const USER = '65f0000000000000000000aa';

// ---- message wording ----------------------------------------------------------------------------------------

test('a down alert says what the check reported, or a plain fallback', () => {
    assert.equal(buildAlertMessage('server_down', { error: 'HTTP 503' }), 'HTTP 503');
    assert.equal(buildAlertMessage('server_down', {}), 'The server did not respond.');
});

test('an overlong error is cut to 300 characters', () => {
    assert.equal(buildAlertMessage('server_down', { error: 'x'.repeat(1000) }).length, 300);
});

test('a recovery mentions the response time when there is one', () => {
    assert.equal(buildAlertMessage('server_recovery', { responseTime: 212.4 }), 'Back online, responding in 212 ms.');
    assert.equal(buildAlertMessage('server_recovery', { responseTime: 0 }), 'Back online.');
});

test('a slow alert compares the response with the users own threshold', () => {
    const server = { monitoring: { alerts: { responseThreshold: 1000 } } };
    assert.equal(
        buildAlertMessage('slow_response', { responseTime: 2310 }, server),
        'Responded in 2310 ms, above your 1000 ms limit.'
    );
    assert.equal(buildAlertMessage('slow_response', { responseTime: 2310 }, {}), 'Responded in 2310 ms.');
    assert.equal(buildAlertMessage('slow_response', {}, {}), 'The server is responding slowly.');
});

test('an unknown alert type has no message', () => {
    assert.equal(buildAlertMessage('mystery', { error: 'x' }), null);
});

// ---- payload shape ------------------------------------------------------------------------------------------

test('an alert row becomes the shape the app reads', () => {
    const item = toAlertItem({
        _id: ID_A,
        serverId: '65f0000000000000000000bb',
        userId: USER,
        type: 'server_down',
        serverName: 'Northwind API',
        serverUrl: 'https://api.northwind.dev',
        message: 'HTTP 503',
        createdAt: new Date('2026-10-24T09:41:00Z'),
        readAt: null,
    });
    assert.deepEqual(item, {
        id: ID_A,
        serverId: '65f0000000000000000000bb',
        serverName: 'Northwind API',
        serverUrl: 'https://api.northwind.dev',
        type: 'server_down',
        message: 'HTTP 503',
        createdAt: '2026-10-24T09:41:00.000Z',
        readAt: null,
    });
    // the owner's id is never part of what is sent to a device
    assert.equal('userId' in item, false);
});

test('rows written before the snapshot fields existed still render', () => {
    const item = toAlertItem({ _id: ID_A, serverId: ID_B, type: 'server_recovery', createdAt: new Date('2026-10-01T00:00:00Z') });
    assert.equal(item.serverName, 'A server');
    assert.equal(item.serverUrl, null);
    assert.equal(item.message, null);
    assert.equal(item.readAt, null);
});

// ---- query parsing ------------------------------------------------------------------------------------------

test('limit defaults, and is kept between 1 and the maximum', () => {
    assert.equal(parseAlertQuery({}).limit, DEFAULT_LIMIT);
    assert.equal(parseAlertQuery({ limit: '0' }).limit, 1);
    assert.equal(parseAlertQuery({ limit: '-5' }).limit, 1);
    assert.equal(parseAlertQuery({ limit: '9999' }).limit, MAX_LIMIT);
    assert.equal(parseAlertQuery({ limit: 'abc' }).limit, DEFAULT_LIMIT);
    assert.equal(parseAlertQuery({ limit: '20' }).limit, 20);
});

test('after and before are only accepted when they are real ids', () => {
    assert.equal(parseAlertQuery({ after: ID_A }).after, ID_A);
    assert.equal(parseAlertQuery({ before: ID_B }).before, ID_B);
    assert.equal(parseAlertQuery({ after: 'not-an-id' }).after, null);
    assert.equal(parseAlertQuery({ after: { $gt: '' } }).after, null);
    assert.equal(parseAlertQuery({}).before, null);
});

// ---- controller: ownership and shape ------------------------------------------------------------------------

const respond = () => {
    const res = {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
    return res;
};

// asyncHandler hands back before the promise settles, so wait for the response to be written
const run = async (handler, req) => {
    const res = respond();
    await new Promise((resolve, reject) => {
        const original = res.json.bind(res);
        res.json = (body) => {
            original(body);
            resolve();
            return res;
        };
        handler(req, res, reject);
    });
    return res;
};

const fakeFind = (rows) => {
    const chain = { sort: () => chain, limit: () => chain, lean: async () => rows };
    return chain;
};

test('the feed is always the signed-in users, newest first, with an unread count', async (t) => {
    const calls = {};
    t.mock.method(AlertEvent, 'find', (filter) => {
        calls.filter = filter;
        return fakeFind([
            { _id: ID_B, serverId: ID_A, type: 'server_down', serverName: 'Northwind API', createdAt: new Date('2026-10-24T10:00:00Z') },
        ]);
    });
    t.mock.method(AlertEvent, 'countDocuments', async (filter) => {
        calls.countFilter = filter;
        return 3;
    });

    // a hostile userId in the query string must not widen the filter
    const res = await run(getAlerts, { user: { _id: USER }, query: { userId: 'someone-else', after: ID_A } });

    assert.equal(res.statusCode, 200);
    assert.equal(calls.filter.userId, USER);
    assert.deepEqual(calls.filter._id, { $gt: ID_A });
    assert.deepEqual(calls.countFilter, { userId: USER, readAt: null });
    assert.equal(res.body.data.unreadCount, 3);
    assert.equal(res.body.data.alerts.length, 1);
    assert.equal(res.body.data.alerts[0].id, ID_B);
});

test('with no paging parameters the feed has no id condition', async (t) => {
    let filter;
    t.mock.method(AlertEvent, 'find', (f) => {
        filter = f;
        return fakeFind([]);
    });
    t.mock.method(AlertEvent, 'countDocuments', async () => 0);

    await run(getAlerts, { user: { _id: USER }, query: {} });
    assert.deepEqual(filter, { userId: USER });
});

test('marking an alert read only touches the users own, still-unread alert', async (t) => {
    let update;
    t.mock.method(AlertEvent, 'updateOne', async (filter, change) => {
        update = { filter, change };
        return { matchedCount: 1 };
    });

    const res = await run(markAlertRead, { user: { _id: USER }, params: { id: ID_A } });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(update.filter, { _id: ID_A, userId: USER, readAt: null });
    assert.ok(update.change.$set.readAt instanceof Date);
});

test('marking an alert read twice is fine, and someone elses alert is not found', async (t) => {
    t.mock.method(AlertEvent, 'updateOne', async () => ({ matchedCount: 0 }));
    const exists = t.mock.method(AlertEvent, 'exists', async () => ({ _id: ID_A }));

    let res = await run(markAlertRead, { user: { _id: USER }, params: { id: ID_A } });
    assert.equal(res.statusCode, 200, 'already read');

    exists.mock.mockImplementation(async () => null);
    res = await run(markAlertRead, { user: { _id: USER }, params: { id: ID_B } });
    assert.equal(res.statusCode, 404, 'not this users alert');
});

test('read-all only updates the users unread alerts', async (t) => {
    let call;
    t.mock.method(AlertEvent, 'updateMany', async (filter, change) => {
        call = { filter, change };
        return { modifiedCount: 4 };
    });

    const res = await run(markAllAlertsRead, { user: { _id: USER } });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(call.filter, { userId: USER, readAt: null });
    assert.equal(res.body.data.updated, 4);
});
