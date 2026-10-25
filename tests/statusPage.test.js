// Run with: npm test
// Public status pages: the rules (addresses, plans, what a stranger sees) and the endpoints. No database or Redis:
// the models' methods are swapped for fakes and the cache is a plain object.

import test from 'node:test';
import assert from 'node:assert/strict';
import StatusPage from '../models/StatusPage.js';
import Server from '../models/Server.js';
import ServerCheck from '../models/ServerCheck.js';
import Incident from '../models/Incident.js';
import User from '../models/User.js';
import { createStatusPageHandlers, allowanceFor } from '../controllers/statusPageHandlers.js';
import { statusPageAllowance } from '../utils/planFeatures.js';
import {
    buildPublicStatus,
    componentState,
    createStatusPageSchema,
    dailyUptime,
    dayState,
    isValidSlug,
    lastDays,
    overallState,
    updateStatusPageSchema
} from '../utils/statusPage.js';

const NOW = new Date('2026-10-25T10:30:00Z').getTime();
const USER = '65f0000000000000000000aa';
const S1 = '65f000000000000000000001';
const S2 = '65f000000000000000000002';
const S3 = '65f000000000000000000003';
const PAGE_ID = '65f0000000000000000000cc';

// ---- addresses ----

test('an address is 3 to 40 lowercase letters, numbers and single hyphens, and not a reserved word', () => {
    for (const ok of ['acme', 'acme-status', 'a1b', 'my-shop-2', 'x'.repeat(40)]) assert.equal(isValidSlug(ok), true, ok);
    for (const bad of ['ab', 'x'.repeat(41), 'Acme', '-acme', 'acme-', 'ac--me', 'ac_me', 'ac me', 'acme.com', 'admin', 'api', 'status', 'pingpilott', '', null, undefined, 42]) {
        assert.equal(isValidSlug(bad), false, String(bad));
    }
});

// ---- what an owner may send ----

test('creating needs an address and a title, trims and lowercases, and ignores nothing it does not know', () => {
    const ok = createStatusPageSchema.safeParse({ slug: '  Acme-Status ', title: ' Acme ' });
    assert.equal(ok.success, true);
    assert.equal(ok.data.slug, 'acme-status');
    assert.equal(ok.data.title, 'Acme');

    assert.equal(createStatusPageSchema.safeParse({ title: 'x' }).success, false, 'no address');
    assert.equal(createStatusPageSchema.safeParse({ slug: 'acme' }).success, false, 'no title');
    assert.equal(createStatusPageSchema.safeParse({ slug: 'admin', title: 'x' }).success, false, 'reserved');
    // an owner cannot set who owns it, or any other field
    assert.equal(createStatusPageSchema.safeParse({ slug: 'acme', title: 'x', userId: USER }).success, false);
    assert.equal(updateStatusPageSchema.safeParse({ userId: USER }).success, false);
});

test('monitors on a page are real ids, at most once each, with short labels', () => {
    const base = { slug: 'acme', title: 'Acme' };
    assert.equal(createStatusPageSchema.safeParse({ ...base, servers: [{ serverId: S1, label: 'Website' }, { serverId: S2 }] }).success, true);
    assert.equal(createStatusPageSchema.safeParse({ ...base, servers: [{ serverId: 'nope' }] }).success, false);
    assert.equal(createStatusPageSchema.safeParse({ ...base, servers: [{ serverId: S1 }, { serverId: S1 }] }).success, false);
    assert.equal(createStatusPageSchema.safeParse({ ...base, servers: [{ serverId: S1, label: 'x'.repeat(61) }] }).success, false);
    assert.equal(createStatusPageSchema.safeParse({ ...base, servers: Array.from({ length: 51 }, (_, i) => ({ serverId: S1.slice(0, -2) + String(10 + i) })) }).success, false);
});

test('an update may send any one field', () => {
    assert.equal(updateStatusPageSchema.safeParse({ published: true }).success, true);
    assert.equal(updateStatusPageSchema.safeParse({}).success, true);
    assert.equal(updateStatusPageSchema.safeParse({ title: '' }).success, false);
});

// ---- plans ----

test('plans allow 1, 1, 3 and 10 pages, and only the first two carry the footer', () => {
    assert.deepEqual(statusPageAllowance('free'), { pages: 1, branded: true });
    assert.deepEqual(statusPageAllowance('starter_monthly'), { pages: 1, branded: true });
    assert.deepEqual(statusPageAllowance('pro_yearly'), { pages: 3, branded: false });
    assert.deepEqual(statusPageAllowance('business_monthly'), { pages: 10, branded: false });
    assert.deepEqual(statusPageAllowance('mystery'), { pages: 1, branded: true });
    assert.deepEqual(allowanceFor({ role: 'admin' }), { pages: null, branded: false });
    assert.deepEqual(allowanceFor({ role: 'user', subscription: { plan: 'pro_monthly' } }), { pages: 3, branded: false });
});

// ---- the numbers ----

test('the bar covers the last 30 days, oldest first, ending today (UTC)', () => {
    const days = lastDays(NOW);
    assert.equal(days.length, 30);
    assert.equal(days[29], '2026-10-25');
    assert.equal(days[0], '2026-09-26');
    assert.equal(new Set(days).size, 30);
});

test('a day is fine at 99.9% or more, a bad patch above 95%, mostly down below, and empty with no checks', () => {
    assert.deepEqual([dayState(100), dayState(99.9), dayState(99.8), dayState(95), dayState(94.9), dayState(0), dayState(null)], ['ok', 'ok', 'minor', 'minor', 'major', 'major', 'none']);
});

test('daily uptime fills each day from its own checks and totals the period', () => {
    const rows = [
        { serverId: S1, day: '2026-10-25', up: 90, total: 100 },
        { serverId: S1, day: '2026-10-24', up: 100, total: 100 },
        { serverId: S2, day: '2026-10-25', up: 1, total: 100 }
    ];
    const { days, uptime } = dailyUptime(rows, S1, NOW);
    assert.deepEqual(days[29], { date: '2026-10-25', uptime: 90, state: 'major' });
    assert.deepEqual(days[28], { date: '2026-10-24', uptime: 100, state: 'ok' });
    assert.deepEqual(days[0], { date: '2026-09-26', uptime: null, state: 'none' });
    assert.equal(uptime, 95, '190 of 200');
    assert.equal(dailyUptime([], S1, NOW).uptime, null);
    assert.equal(dailyUptime([{ serverId: S1, day: '2026-10-25', up: 0, total: 0 }], S1, NOW).uptime, null, 'no counted checks is no data, not 0%');
});

test('a monitor is operational, slow, down, or unknown (paused, or not checked yet)', () => {
    assert.equal(componentState({ status: 'up' }), 'operational');
    assert.equal(componentState({ status: 'up', slowAlerted: true }), 'degraded');
    assert.equal(componentState({ status: 'down' }), 'down');
    assert.equal(componentState({ status: 'unknown' }), 'unknown');
    assert.equal(componentState({ status: 'down', pausedAt: new Date() }), 'unknown');
});

test('the banner follows the worst state, and a page with nothing on it is unknown', () => {
    assert.equal(overallState([]), 'unknown');
    assert.equal(overallState(['operational', 'operational']), 'operational');
    assert.equal(overallState(['operational', 'degraded']), 'degraded');
    assert.equal(overallState(['operational', 'down']), 'partial');
    assert.equal(overallState(['down', 'down']), 'major');
    assert.equal(overallState(['unknown', 'unknown']), 'unknown');
    assert.equal(overallState(['unknown', 'operational']), 'operational');
});

// ---- what a stranger sees ----

const servers = [
    { _id: S1, name: 'Shop internal name', url: 'https://secret-shop.internal.example', status: 'up', error: 'Connection refused', failureKind: 'refused', contactEmails: ['owner@example.com'], uploadedBy: USER },
    { _id: S2, name: 'API', url: 'api.example.com:443', status: 'down', error: 'HTTP 502: Bad Gateway', failureKind: 'http', slowAlerted: false }
];
const page = { slug: 'acme', title: 'Acme', description: 'Our services', indexable: false, userId: USER, servers: [{ serverId: S2, label: '' }, { serverId: S1, label: 'Website' }, { serverId: S3, label: 'Deleted one' }] };
const incidents = [
    { serverId: S2, startedAt: new Date(NOW - 3600_000), endedAt: null, open: true, error: 'HTTP 502: Bad Gateway', failureKind: 'http' },
    { serverId: S1, startedAt: new Date(NOW - 5 * 86400_000), endedAt: new Date(NOW - 5 * 86400_000 + 600_000), open: false, error: 'Connection refused' },
    { serverId: S1, startedAt: new Date(NOW - 20 * 86400_000), endedAt: new Date(NOW - 20 * 86400_000 + 600_000), open: false, error: 'too old' },
    { serverId: S3, startedAt: new Date(NOW - 3600_000), endedAt: null, open: true, error: 'a deleted monitor' },
    { serverId: '65f0000000000000000000ff', startedAt: new Date(NOW - 3600_000), endedAt: null, open: true, error: 'someone else\'s monitor' }
];

test('a public page lists the owner\'s monitors in order, with their labels, and drops one that was deleted', () => {
    const view = buildPublicStatus({ page, servers, dailyRows: [], incidents, allowance: { branded: true }, now: NOW });
    assert.deepEqual(view.components.map((c) => [c.name, c.state]), [['API', 'down'], ['Website', 'operational']]);
    assert.equal(view.overall, 'partial');
    assert.equal(view.title, 'Acme');
    assert.equal(view.components[0].days.length, 30);
});

test('a public page never carries an address, an error, a failure kind, an email or an owner', () => {
    const view = buildPublicStatus({ page, servers, dailyRows: [], incidents, allowance: { branded: true }, now: NOW });
    const text = JSON.stringify(view);
    for (const secret of ['secret-shop', 'internal.example', 'api.example.com', 'Connection refused', 'Bad Gateway', 'HTTP 502', 'failureKind', 'refused', 'owner@example.com', USER, 'Shop internal name', 'userId', 'contactEmails']) {
        assert.equal(text.includes(secret), false, `leaked: ${secret}`);
    }
});

test('incidents are those of the page\'s own monitors in the last 14 days, newest first, with times and no cause', () => {
    const view = buildPublicStatus({ page, servers, dailyRows: [], incidents, allowance: { branded: true }, now: NOW });
    assert.equal(view.incidents.length, 2);
    assert.deepEqual(view.incidents.map((i) => i.name), ['API', 'Website']);
    assert.equal(view.incidents[0].ongoing, true);
    assert.equal(view.incidents[0].durationMs, null);
    assert.equal(view.incidents[0].endedAt, null);
    assert.equal(view.incidents[1].durationMs, 600_000);
    assert.deepEqual(Object.keys(view.incidents[1]).sort(), ['durationMs', 'endedAt', 'name', 'ongoing', 'startedAt']);
});

test('the "Powered by" footer follows the plan', () => {
    assert.equal(buildPublicStatus({ page, servers, dailyRows: [], incidents: [], allowance: { branded: true }, now: NOW }).poweredBy, true);
    assert.equal(buildPublicStatus({ page, servers, dailyRows: [], incidents: [], allowance: { branded: false }, now: NOW }).poweredBy, false);
    assert.equal(buildPublicStatus({ page, servers, dailyRows: [], incidents: [], now: NOW }).poweredBy, false);
});

// ---- the endpoints ----

const respond = () => ({
    statusCode: null, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(body) { this.body = body; return this; }
});

// asyncHandler hands back before the promise settles, so wait for the response to be written
const run = async (handler, req) => {
    const res = respond();
    await new Promise((resolve, reject) => {
        const original = res.json.bind(res);
        res.json = (body) => { original(body); resolve(); return res; };
        handler(req, res, reject);
    });
    return res;
};

const chain = (rows) => {
    const c = { select: () => c, sort: () => c, limit: () => c, lean: async () => rows };
    return c;
};

const memoryCache = () => {
    const store = new Map();
    const calls = { get: [], set: [], del: [] };
    return {
        calls,
        get: async (key) => { calls.get.push(key); return store.get(key) ?? null; },
        set: async (key, value, ttl) => { calls.set.push([key, ttl]); store.set(key, value); },
        del: async (key) => { calls.del.push(key); store.delete(key); }
    };
};

const user = (plan = 'free', extra = {}) => ({ _id: USER, role: 'user', subscription: { plan }, ...extra });

test('the owner\'s list is only theirs, with the limit and how many are used', async (t) => {
    let filter;
    t.mock.method(StatusPage, 'find', (f) => { filter = f; return chain([{ _id: PAGE_ID, slug: 'acme', title: 'Acme', servers: [{ serverId: S1, label: '' }], published: true, indexable: false }]); });
    const { listStatusPages } = createStatusPageHandlers({ cache: memoryCache() });
    const res = await run(listStatusPages, { user: user('pro_monthly'), query: {} });
    assert.deepEqual(filter, { userId: USER });
    assert.equal(res.body.data.limit, 3);
    assert.equal(res.body.data.used, 1);
    assert.equal(res.body.data.branded, false);
    assert.equal(res.body.data.pages[0].path, '/status/acme');
    assert.equal('userId' in res.body.data.pages[0], false);
});

test('an address check says whether it is valid and free', async (t) => {
    t.mock.method(StatusPage, 'exists', async ({ slug }) => (slug === 'taken-one' ? { _id: PAGE_ID } : null));
    const { checkSlug } = createStatusPageHandlers({ cache: memoryCache() });
    assert.deepEqual((await run(checkSlug, { user: user(), query: { slug: 'taken-one' } })).body.data, { slug: 'taken-one', valid: true, available: false });
    assert.deepEqual((await run(checkSlug, { user: user(), query: { slug: 'free-one' } })).body.data, { slug: 'free-one', valid: true, available: true });
    assert.deepEqual((await run(checkSlug, { user: user(), query: { slug: 'admin' } })).body.data, { slug: 'admin', valid: false, available: false });
    assert.equal((await run(checkSlug, { user: user(), query: { slug: { $gt: '' } } })).body.data.valid, false);
});

test('creating a page at the plan limit is refused, and says how many the plan includes', async (t) => {
    t.mock.method(StatusPage, 'countDocuments', async () => 1);
    const create = t.mock.method(StatusPage, 'create', async () => { throw new Error('should not be created'); });
    const { createStatusPage } = createStatusPageHandlers({ cache: memoryCache() });
    const res = await run(createStatusPage, { user: user('free'), body: { slug: 'second', title: 'Second' } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'STATUS_PAGE_LIMIT');
    assert.match(res.body.message, /includes 1 status page\./);
    assert.equal(create.mock.callCount(), 0);
});

test('a paid plan with room creates a page, owned by the signed-in user whatever the body says', async (t) => {
    t.mock.method(StatusPage, 'countDocuments', async () => 2);
    t.mock.method(Server, 'countDocuments', async (f) => { assert.deepEqual(f, { _id: { $in: [S1] }, uploadedBy: USER }); return 1; });
    let doc;
    t.mock.method(StatusPage, 'create', async (d) => { doc = d; return { toObject: () => ({ _id: PAGE_ID, ...d }) }; });
    const { createStatusPage } = createStatusPageHandlers({ cache: memoryCache() });
    const res = await run(createStatusPage, { user: user('pro_monthly'), body: { slug: 'Acme', title: 'Acme', servers: [{ serverId: S1, label: 'Website' }], published: true } });
    assert.equal(res.statusCode, 201);
    assert.equal(doc.userId, USER);
    assert.equal(doc.slug, 'acme');
    assert.equal(doc.published, true);
    assert.equal(doc.indexable, false, 'not indexed unless asked');
    assert.equal(res.body.data.page.path, '/status/acme');
});

test('a body that tries to set the owner is refused, and so is a monitor that is not the user\'s', async (t) => {
    t.mock.method(StatusPage, 'countDocuments', async () => 0);
    t.mock.method(Server, 'countDocuments', async () => 0);
    const create = t.mock.method(StatusPage, 'create', async () => ({}));
    const { createStatusPage } = createStatusPageHandlers({ cache: memoryCache() });

    const sneaky = await run(createStatusPage, { user: user(), body: { slug: 'acme', title: 'x', userId: 'someone-else' } });
    assert.equal(sneaky.statusCode, 400);

    const foreign = await run(createStatusPage, { user: user(), body: { slug: 'acme', title: 'x', servers: [{ serverId: S1 }] } });
    assert.equal(foreign.statusCode, 400);
    assert.equal(foreign.body.code, 'INVALID_SERVER');
    assert.equal(create.mock.callCount(), 0);
});

test('an address someone else has is a 409', async (t) => {
    t.mock.method(StatusPage, 'countDocuments', async () => 0);
    t.mock.method(StatusPage, 'create', async () => { throw Object.assign(new Error('dup'), { code: 11000 }); });
    const { createStatusPage } = createStatusPageHandlers({ cache: memoryCache() });
    const res = await run(createStatusPage, { user: user(), body: { slug: 'acme', title: 'x' } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'SLUG_TAKEN');
});

test('editing finds the page by owner, saves it, and clears the cached copy of the old and new address', async (t) => {
    let filter;
    const doc = { _id: PAGE_ID, slug: 'old-name', title: 'Old', description: '', servers: [], published: false, indexable: false, async save() { this.saved = true; }, toObject() { return { ...this }; } };
    t.mock.method(StatusPage, 'findOne', async (f) => { filter = f; return doc; });
    const cache = memoryCache();
    const { updateStatusPage } = createStatusPageHandlers({ cache });
    const res = await run(updateStatusPage, { user: user(), params: { id: PAGE_ID }, body: { slug: 'new-name', published: true } });
    assert.deepEqual(filter, { _id: PAGE_ID, userId: USER });
    assert.equal(res.statusCode, 200);
    assert.equal(doc.slug, 'new-name');
    assert.equal(doc.published, true);
    assert.equal(doc.title, 'Old', 'fields not sent are left alone');
    assert.ok(doc.saved);
    assert.deepEqual(cache.calls.del.sort(), ['public:status:new-name', 'public:status:old-name']);
});

test('editing or deleting a page that is not the user\'s is a 404, and a bad id is a 400', async (t) => {
    t.mock.method(StatusPage, 'findOne', async () => null);
    t.mock.method(StatusPage, 'findOneAndDelete', () => ({ lean: async () => null }));
    const { updateStatusPage, deleteStatusPage } = createStatusPageHandlers({ cache: memoryCache() });
    assert.equal((await run(updateStatusPage, { user: user(), params: { id: PAGE_ID }, body: { title: 'x' } })).statusCode, 404);
    assert.equal((await run(deleteStatusPage, { user: user(), params: { id: PAGE_ID } })).statusCode, 404);
    assert.equal((await run(updateStatusPage, { user: user(), params: { id: 'nope' }, body: {} })).statusCode, 400);
    assert.equal((await run(deleteStatusPage, { user: user(), params: { id: { $gt: '' } } })).statusCode, 400);
});

test('deleting a page removes it and its cached copy', async (t) => {
    let filter;
    t.mock.method(StatusPage, 'findOneAndDelete', (f) => { filter = f; return { lean: async () => ({ _id: PAGE_ID, slug: 'acme' }) }; });
    const cache = memoryCache();
    const { deleteStatusPage } = createStatusPageHandlers({ cache });
    const res = await run(deleteStatusPage, { user: user(), params: { id: PAGE_ID } });
    assert.deepEqual(filter, { _id: PAGE_ID, userId: USER });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(cache.calls.del, ['public:status:acme']);
});

const mockPublicData = (t, { pageDoc = page, owner = { role: 'user', subscription: { plan: 'free' } } } = {}) => {
    const find = t.mock.method(StatusPage, 'findOne', (f) => { find.filter = f; return { lean: async () => pageDoc }; });
    const serverFind = t.mock.method(Server, 'find', (f) => { serverFind.filter = f; return chain(servers); });
    t.mock.method(User, 'findById', () => chain(owner));
    t.mock.method(ServerCheck, 'aggregate', () => ({
        allowDiskUse: async () => [{ _id: { serverId: S1, day: '2026-10-25' }, up: 99, total: 100 }]
    }));
    t.mock.method(Incident, 'find', () => chain(incidents));
    return { find, serverFind };
};

test('a stranger gets a published page, built from the database once and then cached for a minute', async (t) => {
    const { find, serverFind } = mockPublicData(t);
    const cache = memoryCache();
    const { getPublicStatus } = createStatusPageHandlers({ cache });

    const first = await run(getPublicStatus, { params: { slug: 'ACME' } });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(find.filter, { slug: 'acme', published: true }, 'only published pages');
    assert.deepEqual(serverFind.filter._id, { $in: [S2, S1, S3] });
    assert.equal(serverFind.filter.uploadedBy, USER, 'only the page owner\'s monitors');
    assert.equal(first.body.data.poweredBy, true, 'a free plan carries the footer');
    assert.equal(first.body.data.components.find((c) => c.name === 'Website').uptime, 99);
    assert.deepEqual(cache.calls.set, [['public:status:acme', 60]]);
    assert.match(first.headers['Cache-Control'], /public/);

    // the second visitor is served from the cache: nothing is read again
    find.mock.resetCalls();
    const second = await run(getPublicStatus, { params: { slug: 'acme' } });
    assert.equal(second.statusCode, 200);
    assert.equal(find.mock.callCount(), 0);
    assert.equal(second.body.data.title, 'Acme');
});

test('an unpublished or unknown page is a 404 and is not cached', async (t) => {
    mockPublicData(t, { pageDoc: null });
    const cache = memoryCache();
    const { getPublicStatus } = createStatusPageHandlers({ cache });
    const res = await run(getPublicStatus, { params: { slug: 'nothing-here' } });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(cache.calls.set, []);
});

test('something that cannot be an address is a 404 without touching the cache or the database', async (t) => {
    const find = t.mock.method(StatusPage, 'findOne', () => { throw new Error('should not be read'); });
    const cache = memoryCache();
    const { getPublicStatus } = createStatusPageHandlers({ cache });
    for (const slug of ['a', 'admin', '../etc/passwd', 'x'.repeat(80), { $gt: '' }, undefined]) {
        const res = await run(getPublicStatus, { params: { slug } });
        assert.equal(res.statusCode, 404, String(slug));
    }
    assert.equal(find.mock.callCount(), 0);
    assert.deepEqual(cache.calls.get, []);
});

test('a page on a Pro plan has no footer, and one with no monitors still builds', async (t) => {
    mockPublicData(t, { pageDoc: { ...page, servers: [] }, owner: { role: 'user', subscription: { plan: 'pro_monthly' } } });
    const { getPublicStatus } = createStatusPageHandlers({ cache: memoryCache() });
    const res = await run(getPublicStatus, { params: { slug: 'acme' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.poweredBy, false);
    assert.deepEqual(res.body.data.components, []);
    assert.equal(res.body.data.overall, 'unknown');
});
