// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentList, downtimeWithin, periodStart } from '../utils/incidentList.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-24T12:00:00Z');
const ago = (ms) => new Date(NOW - ms);

const servers = [
    { _id: 's1', name: 'Northwind API', url: 'https://api.northwind.dev' },
    { _id: 's2', name: 'Larkspur Shop', url: 'https://shop.larkspur.co' },
];

// newest first, as the query returns them
const rows = [
    { _id: 'i4', serverId: 's1', startedAt: ago(2 * HOUR), endedAt: null, open: true, error: 'Request timed out' },
    { _id: 'i3', serverId: 's2', startedAt: ago(1 * DAY), endedAt: ago(1 * DAY - 30 * 60000), open: false, error: 'HTTP 503' },
    { _id: 'i2', serverId: 's1', startedAt: ago(3 * DAY), endedAt: ago(3 * DAY - 5 * 60000), open: false, error: null },
    { _id: 'i1', serverId: 's1', startedAt: ago(20 * DAY), endedAt: ago(20 * DAY - 10 * 60000), open: false, error: 'ECONNRESET' },
];

test('periodStart goes back the requested number of days', () => {
    assert.equal(periodStart(7, NOW).getTime(), NOW - 7 * DAY);
});

test('downtime only counts the part inside the period', () => {
    const since = periodStart(7, NOW);
    // an ongoing incident that began 10 days ago has been inside the 7 day window for 7 days
    const old = { startedAt: ago(10 * DAY), endedAt: null };
    assert.equal(downtimeWithin(old, since, NOW), 7 * DAY);
    // a finished one entirely inside counts in full
    assert.equal(downtimeWithin({ startedAt: ago(DAY), endedAt: ago(DAY - 30 * 60000) }, since, NOW), 30 * 60000);
    // a finished one entirely before the window counts for nothing
    assert.equal(downtimeWithin({ startedAt: ago(20 * DAY), endedAt: ago(20 * DAY - HOUR) }, since, NOW), 0);
});

test('the 7 day list leaves out older incidents, the 30 day list includes them', () => {
    assert.deepEqual(buildIncidentList(rows, servers, { days: 7, now: NOW }).incidents.map((i) => i.id), ['i4', 'i3', 'i2']);
    assert.deepEqual(buildIncidentList(rows, servers, { days: 30, now: NOW }).incidents.map((i) => i.id), ['i4', 'i3', 'i2', 'i1']);
});

test('the summary counts incidents, ongoing ones and downtime for the period', () => {
    const { summary } = buildIncidentList(rows, servers, { days: 7, now: NOW });
    assert.equal(summary.total, 3);
    assert.equal(summary.ongoing, 1);
    assert.equal(summary.downtimeMs, 2 * HOUR + 30 * 60000 + 5 * 60000);
});

test('the status filter narrows the list but not the summary', () => {
    const ongoing = buildIncidentList(rows, servers, { status: 'ongoing', days: 30, now: NOW });
    assert.deepEqual(ongoing.incidents.map((i) => i.id), ['i4']);
    assert.equal(ongoing.summary.total, 4);
    const resolved = buildIncidentList(rows, servers, { status: 'resolved', days: 30, now: NOW });
    assert.deepEqual(resolved.incidents.map((i) => i.id), ['i3', 'i2', 'i1']);
    assert.equal(resolved.summary.ongoing, 1);
});

test('an ongoing incident has no duration, a finished one has its length', () => {
    const { incidents } = buildIncidentList(rows, servers, { days: 7, now: NOW });
    assert.equal(incidents[0].ongoing, true);
    assert.equal(incidents[0].durationMs, null);
    assert.equal(incidents[0].endedAt, null);
    assert.equal(incidents[1].ongoing, false);
    assert.equal(incidents[1].durationMs, 30 * 60000);
});

test('each incident carries its server name and address, or a fallback if the server is gone', () => {
    const { incidents } = buildIncidentList([...rows, { _id: 'i0', serverId: 'gone', startedAt: ago(HOUR), endedAt: ago(HOUR - 60000), open: false }], servers, { days: 7, now: NOW });
    assert.equal(incidents.find((i) => i.id === 'i4').serverName, 'Northwind API');
    assert.equal(incidents.find((i) => i.id === 'i3').serverUrl, 'https://shop.larkspur.co');
    assert.equal(incidents.find((i) => i.id === 'i0').serverName, 'Deleted server');
    assert.equal(incidents.find((i) => i.id === 'i0').serverUrl, null);
});

test('paging splits the list and reports the totals', () => {
    const first = buildIncidentList(rows, servers, { days: 30, page: 1, limit: 3, now: NOW });
    assert.deepEqual(first.incidents.map((i) => i.id), ['i4', 'i3', 'i2']);
    assert.deepEqual(first.pagination, { page: 1, limit: 3, total: 4, totalPages: 2 });
    const second = buildIncidentList(rows, servers, { days: 30, page: 2, limit: 3, now: NOW });
    assert.deepEqual(second.incidents.map((i) => i.id), ['i1']);
});

test('a user with no incidents gets an empty list and a zero summary', () => {
    const result = buildIncidentList([], servers, { now: NOW });
    assert.deepEqual(result.incidents, []);
    assert.deepEqual(result.summary, { total: 0, ongoing: 0, downtimeMs: 0 });
    assert.equal(result.pagination.totalPages, 1);
});
