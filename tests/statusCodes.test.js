// Run with: npm test
// Which HTTP status codes count as "up" is the owner's to set (monitoring.acceptedStatus, e.g. "200-399,401,403"). The
// default is unchanged: 200 to 399. A check that fails on a 401, 403 or 429 says the server did answer, and where to
// change it, because a login wall, a bot filter and a rate limit all answer while the site is alive.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseStatusSpec, isValidStatusSpec, normalizeStatusSpec, acceptedRanges, statusAccepted, DEFAULT_RANGES } from '../utils/statusSpec.js';
import { createServerSchema, updateServerSchema } from '../utils/validations.js';
import { buildMonitoringConfig, buildMonitoringUpdates } from '../utils/monitoringSettings.js';
import { checkServerStatus } from '../services/monitoringService.js';
import { HttpStatusError } from '../utils/failures.js';
import Server from '../models/Server.js';

// ── the spec ──

test('codes and ranges, with spaces allowed, are read as ranges and written back tidy', () => {
    assert.deepEqual(parseStatusSpec('200-399'), { ok: true, ranges: [[200, 399]], spec: '200-399', isDefault: false });
    assert.deepEqual(parseStatusSpec(' 200-399 , 401 ,403 '), { ok: true, ranges: [[200, 399], [401, 401], [403, 403]], spec: '200-399,401,403', isDefault: false });
    assert.deepEqual(parseStatusSpec('404').ranges, [[404, 404]]);
    assert.deepEqual(parseStatusSpec('100-599').ranges, [[100, 599]], 'any answer at all');
    assert.equal(parseStatusSpec('200 - 299').spec, '200-299');
});

test('empty means the default, 200 to 399', () => {
    for (const empty of ['', '   ', undefined, null]) {
        const parsed = parseStatusSpec(empty);
        assert.equal(parsed.ok, true);
        assert.equal(parsed.isDefault, true);
        assert.deepEqual(parsed.ranges, DEFAULT_RANGES);
    }
    assert.deepEqual(DEFAULT_RANGES, [[200, 399]]);
});

test('anything that is not a status code or a range is refused, with a reason', () => {
    const bad = {
        'abc': /not a status code/,
        '200-': /not a status code/,
        '20': /not a status code/,
        '2000': /not a status code/,
        '200;300': /not a status code/,
        '200,,300': /not a status code/,
        '99': /not a status code/,
        '099': /between 100 and 599/,
        '600': /between 100 and 599/,
        '099-200': /between 100 and 599/,
        '300-200': /runs backwards/,
        [Array.from({ length: 11 }, (_, i) => 200 + i).join(',')]: /at most 10/,
        [`200-299,${'4'.repeat(70)}`]: /at most 60 characters/
    };
    for (const [spec, reason] of Object.entries(bad)) {
        const parsed = parseStatusSpec(spec);
        assert.equal(parsed.ok, false, spec.slice(0, 30));
        assert.match(parsed.error, reason, spec.slice(0, 30));
        assert.equal(isValidStatusSpec(spec), false);
    }
});

test('a status is accepted inside a range, edges included', () => {
    const ranges = acceptedRanges('200-399,401');
    for (const status of [200, 301, 399, 401]) assert.equal(statusAccepted(status, ranges), true, String(status));
    for (const status of [199, 400, 402, 403, 500]) assert.equal(statusAccepted(status, ranges), false, String(status));
    assert.equal(statusAccepted(404), false, 'the default when no ranges are given');
    assert.equal(statusAccepted(399), true);
});

test('a stored value that cannot be read counts as the default, so a bad row never fails every check', () => {
    assert.deepEqual(acceptedRanges('banana'), DEFAULT_RANGES);
    assert.deepEqual(acceptedRanges(undefined), DEFAULT_RANGES);
    assert.equal(normalizeStatusSpec('banana'), '');
    assert.equal(normalizeStatusSpec('200-399, 401'), '200-399,401');
    assert.equal(normalizeStatusSpec(''), '');
});

// ── the sentence on a failure ──

test('a failure on 401, 403 or 429 says the server answered, and where to change it; other failures stay as they were', () => {
    for (const code of [401, 403, 429]) {
        const message = new HttpStatusError(code, 'Whatever').message;
        assert.match(message, new RegExp(`^HTTP ${code}: Whatever\\. The server did answer\\.`));
        assert.match(message, new RegExp(`add ${code} to the status codes that count as up in this server's settings`));
    }
    assert.equal(new HttpStatusError(404).message, 'HTTP 404');
    assert.equal(new HttpStatusError(503, 'Service Unavailable').message, 'HTTP 503: Service Unavailable');
    assert.equal(new HttpStatusError(500, 'Internal Server Error').message, 'HTTP 500: Internal Server Error');
});

// ── the setting, as it is sent and stored ──

const base = { name: 'Shop', url: 'shop.example.com' };

test('the create and update validation accept a good list, an empty one, and refuse a bad one', () => {
    for (const schema of [createServerSchema, updateServerSchema]) {
        const ok = schema.safeParse({ ...base, monitoring: { acceptedStatus: '200-399,401,403' } });
        assert.equal(ok.success, true);
        assert.equal(ok.data.monitoring.acceptedStatus, '200-399,401,403');

        assert.equal(schema.safeParse({ ...base, monitoring: { acceptedStatus: '' } }).success, true, 'empty puts it back on the default');
        assert.equal(schema.safeParse({ ...base, monitoring: {} }).success, true, 'and it is optional');

        const bad = schema.safeParse({ ...base, monitoring: { acceptedStatus: '200-abc' } });
        assert.equal(bad.success, false);
        assert.equal(bad.error.issues[0].path.join('.'), 'monitoring.acceptedStatus');
        assert.match(bad.error.issues[0].message, /not a status code/);

        assert.equal(schema.safeParse({ ...base, monitoring: { acceptedStatus: 200 } }).success, false, 'a number is not a list');
    }
});

test('the server model refuses a bad list and takes a good one', () => {
    const owner = '5f1d7f3a8f3c2a1b4c8e9d10';
    const make = (acceptedStatus) => new Server({ name: 'a', url: 'a.com', uploadedBy: owner, monitoring: { acceptedStatus } });
    assert.equal(make('200-399,401').validateSync(), undefined);
    assert.ok(make('nonsense').validateSync()?.errors?.['monitoring.acceptedStatus']);
    assert.equal(new Server({ name: 'a', url: 'a.com', uploadedBy: owner }).monitoring.acceptedStatus, undefined, 'unset by default');
});

test('creating a server stores the list, tidied, and leaves it out when there is none', () => {
    const config = buildMonitoringConfig({ acceptedStatus: '200-399, 401' }, 'user', null);
    assert.equal(config.acceptedStatus, '200-399,401');
    assert.equal('acceptedStatus' in buildMonitoringConfig({}, 'user', null), false);
    assert.equal('acceptedStatus' in buildMonitoringConfig({ acceptedStatus: '' }, 'user', null), false);
});

test('updating a server sets, clears or leaves the list, and takes it from the validated settings only', () => {
    assert.equal(buildMonitoringUpdates({ acceptedStatus: '401' }, { acceptedStatus: '401' })['monitoring.acceptedStatus'], '401');
    assert.equal(buildMonitoringUpdates({ acceptedStatus: ' 200-399 , 401' }, { acceptedStatus: ' 200-399 , 401' })['monitoring.acceptedStatus'], '200-399,401');
    assert.equal(buildMonitoringUpdates({ acceptedStatus: '' }, { acceptedStatus: '' })['monitoring.acceptedStatus'], '', 'empty puts it back on the default');
    assert.equal('monitoring.acceptedStatus' in buildMonitoringUpdates({ frequency: 5 }, { frequency: 5 }), false, 'not sent: not touched');
    assert.equal('monitoring.acceptedStatus' in buildMonitoringUpdates({ acceptedStatus: 'evil' }, {}), false, 'a value that did not pass validation is ignored');
});

test('moving the builders out of the controller changed nothing for the settings that already existed', () => {
    const config = buildMonitoringConfig({ frequency: 10, daysOfWeek: [1, 2], alerts: { enabled: true, email: true, responseThreshold: 500 } }, 'admin', new Date(0));
    assert.equal(config.frequency, 10);
    assert.deepEqual(config.daysOfWeek, [1, 2]);
    assert.deepEqual(config.timeWindows, [{ start: '00:00', end: '23:59' }]);
    assert.deepEqual(config.alerts, { enabled: true, email: true, phone: false, webhookUrl: '', responseThreshold: 500, timeWindow: { start: '00:00', end: '23:59' } });
    assert.equal(config.trialEndsAt, null, 'an admin has no trial');
    assert.equal(buildMonitoringConfig({}, 'user', 'later').trialEndsAt, 'later');

    const updates = buildMonitoringUpdates({ frequency: 3, daysOfWeek: [0], timeWindows: [{ start: '09:00', end: '17:00' }], alerts: { enabled: false, responseThreshold: 800, webhookUrl: undefined } });
    assert.deepEqual(updates, {
        'monitoring.frequency': 3,
        nextCheckAt: null,
        'monitoring.daysOfWeek': [0],
        'monitoring.timeWindows': [{ start: '09:00', end: '17:00' }],
        'monitoring.alerts.enabled': false,
        'monitoring.alerts.responseThreshold': 800
    });
});

// ── real checks ──

let server;
let port;

before(async () => {
    process.env.ALLOW_PRIVATE_TARGETS = 'true';
    server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        let status = Number(url.searchParams.get('status') || 200);
        // a server that turns away HEAD but answers GET: the check falls back to GET, as it always did
        if (url.pathname === '/head405' && req.method === 'HEAD') status = 405;
        if (url.pathname === '/head403' && req.method === 'HEAD') status = 403;
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

const check = (path, acceptedStatus) => checkServerStatus({
    url: `http://127.0.0.1:${port}${path}`,
    type: 'website',
    monitoring: acceptedStatus === undefined ? {} : { acceptedStatus }
});

test('by default only 200 to 399 is up, as it always was', async () => {
    assert.equal((await check('/?status=200')).status, 'up');
    for (const status of [404, 500, 503]) {
        const result = await check(`/?status=${status}`);
        assert.equal(result.status, 'down', String(status));
        assert.deepEqual(result.failure, { kind: 'http', statusCode: status });
        assert.doesNotMatch(result.error, /did answer/, `${status} has no hint`);
    }
});

test('a 401, 403 or 429 is down by default, and says the server answered and where to change it', async () => {
    for (const status of [401, 403, 429]) {
        const result = await check(`/?status=${status}`);
        assert.equal(result.status, 'down', String(status));
        assert.deepEqual(result.failure, { kind: 'http', statusCode: status });
        assert.match(result.error, new RegExp(`^HTTP ${status}`));
        assert.match(result.error, /The server did answer\./);
        assert.match(result.error, new RegExp(`add ${status} to the status codes that count as up`));
    }
});

test('adding 403 to the list makes a 403 up, and the check keeps the status it got', async () => {
    const result = await check('/?status=403', '200-399,403');
    assert.equal(result.status, 'up');
    assert.equal(result.statusCode, 403);
    assert.equal(result.failure, null);
    assert.equal(result.error, null);
    assert.ok(result.responseTime >= 1);

    // and what is not on the list is still down
    assert.equal((await check('/?status=401', '200-399,403')).status, 'down');
    assert.equal((await check('/?status=200', '200-399,403')).status, 'up');
});

test('100-599 counts any answer at all as up', async () => {
    for (const status of [200, 404, 429, 500, 503]) assert.equal((await check(`/?status=${status}`, '100-599')).status, 'up', String(status));
});

test('the list is the list: with only 404 on it a 200 is down', async () => {
    assert.equal((await check('/?status=404', '404')).status, 'up');
    const result = await check('/?status=200', '404');
    assert.equal(result.status, 'down');
    assert.deepEqual(result.failure, { kind: 'http', statusCode: 200 });
});

test('an unreadable or empty stored value behaves as the default', async () => {
    for (const stored of ['banana', '', '   ']) {
        assert.equal((await check('/?status=200', stored)).status, 'up', `"${stored}" with 200`);
        assert.equal((await check('/?status=500', stored)).status, 'down', `"${stored}" with 500`);
    }
});

test('a server that turns away HEAD is still checked with GET, under the default and under a list', async () => {
    for (const path of ['/head405', '/head403']) {
        const plain = await check(path);
        assert.equal(plain.status, 'up', path);
        assert.equal(plain.statusCode, 200, `${path} answered GET with 200`);
        assert.equal((await check(path, '200-399,403')).status, 'up', `${path} with a list`);
    }
});
