// Run with: npm test
// Regression for F11: history was kept for 7 days by default while the apps offered a 30 day view (so its uptime figure
// was really 7 days), the model's TTL said 30, two more modes deleted every check, and nobody could tell from the code
// whether the TTL on a time-series collection was honoured. No database: the Db is a fake that only answers reads.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRetentionDays, legacyRetentionModeNotice, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS } from '../utils/retention.js';
import { inspectRetention, formatRetentionReport } from '../services/retentionCheck.js';

test('with nothing set, 30 days of history are kept, the longest view the apps offer', () => {
    assert.equal(DEFAULT_RETENTION_DAYS, 30);
    for (const unset of [undefined, null, '', '   ']) {
        assert.deepEqual(resolveRetentionDays(unset), { days: 30, recognized: true });
    }
});

test('a whole number of days from 1 to 30 is used', () => {
    assert.deepEqual(resolveRetentionDays('7'), { days: 7, recognized: true });
    assert.deepEqual(resolveRetentionDays(' 14 '), { days: 14, recognized: true });
    assert.deepEqual(resolveRetentionDays('30'), { days: 30, recognized: true });
    assert.equal(MAX_RETENTION_DAYS, 30);
});

test('anything else falls back to 30 and is flagged: never to something that deletes more', () => {
    for (const bad of ['0', '-3', '31', '365', 'soon', '7.5', '1e1']) {
        assert.deepEqual(resolveRetentionDays(bad), { days: 30, recognized: false }, bad);
    }
});

test('the removed DATA_RETENTION_MODE values are reported, and the safe one is not', () => {
    assert.equal(legacyRetentionModeNotice(undefined), null);
    assert.equal(legacyRetentionModeNotice(''), null);
    assert.equal(legacyRetentionModeNotice('selective'), null);
    assert.match(legacyRetentionModeNotice('aggressive'), /no longer used/);
    assert.match(legacyRetentionModeNotice('Emergency'), /removed/);
});

// --- the read-only look at the collection ---

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

const fakeDb = ({ info = { name: 'serverchecks', options: { timeseries: { timeField: 'timestamp' } } }, indexes = [], oldest = NOW - 3 * DAY, newest = NOW - 60_000, version = '7.0.5' } = {}) => {
    const writes = [];
    const cursor = (value) => ({ sort: () => ({ limit: () => ({ toArray: async () => (value === null ? [] : [{ timestamp: new Date(value) }]) }) }) });
    let finds = 0;
    return {
        writes,
        listCollections: () => ({ toArray: async () => (info ? [info] : []) }),
        collection: () => ({
            indexes: async () => indexes,
            find: () => cursor(finds++ === 0 ? oldest : newest),
            // anything that changes data would land here: the check must never call it
            insertOne: async () => writes.push('insert'), createIndex: async () => writes.push('createIndex'), deleteMany: async () => writes.push('delete'),
        }),
        admin: () => ({ command: async () => ({ version }) }),
    };
};

const ttl = (days) => [{ name: 'timestamp_1', key: { timestamp: 1 }, expireAfterSeconds: days * 86400 }];

test('a healthy collection: TTL as long as the retention, oldest check inside it, no problems', async () => {
    const report = await inspectRetention({ db: fakeDb({ indexes: ttl(30), oldest: NOW - 29 * DAY }), retentionDays: 30, now: NOW });
    assert.equal(report.exists, true);
    assert.deepEqual(report.warnings, []);
    assert.equal(report.facts.ttlDays, 30);
    assert.equal(report.facts.timeSeries, true);
    assert.equal(report.facts.serverVersion, '7.0.5');
});

test('no TTL anywhere is reported: only the nightly job bounds growth', async () => {
    const report = await inspectRetention({ db: fakeDb({ indexes: [] }), retentionDays: 30, now: NOW });
    assert.match(report.warnings.join('\n'), /No TTL is set/);
});

test('a TTL shorter than the retention is reported, because the longer history is never kept', async () => {
    const report = await inspectRetention({ db: fakeDb({ indexes: ttl(7) }), retentionDays: 30, now: NOW });
    assert.match(report.warnings.join('\n'), /deletes after 7 days, earlier than the 30 days configured/);
});

test('a collection-level TTL counts too', async () => {
    const db = fakeDb({ info: { name: 'serverchecks', options: { timeseries: {}, expireAfterSeconds: 30 * 86400 } }, indexes: [] });
    const report = await inspectRetention({ db, retentionDays: 30, now: NOW });
    assert.equal(report.facts.ttlDays, 30);
    assert.deepEqual(report.warnings, []);
});

test('checks far older than the retention mean nothing is deleting them', async () => {
    const report = await inspectRetention({ db: fakeDb({ indexes: ttl(30), oldest: NOW - 90 * DAY }), retentionDays: 30, now: NOW });
    assert.match(report.warnings.join('\n'), /oldest check is 90 days old.*neither the nightly job nor the TTL/);
});

test('no new checks for an hour is reported', async () => {
    const report = await inspectRetention({ db: fakeDb({ indexes: ttl(30), newest: NOW - 3 * 60 * 60 * 1000 }), retentionDays: 30, now: NOW });
    assert.match(report.warnings.join('\n'), /newest check was saved at .* more than an hour ago/);
});

test('a missing collection is reported, not an error', async () => {
    const report = await inspectRetention({ db: fakeDb({ info: null }), retentionDays: 30, now: NOW });
    assert.equal(report.exists, false);
    assert.equal(report.warnings.length, 1);
});

test('an empty collection has no oldest check and is fine', async () => {
    const report = await inspectRetention({ db: fakeDb({ indexes: ttl(30), oldest: null, newest: null }), retentionDays: 30, now: NOW });
    assert.equal(report.facts.oldestCheck, null);
    assert.deepEqual(report.warnings, []);
});

test('a user who may not read the server version still gets the rest', async () => {
    const db = fakeDb({ indexes: ttl(30) });
    db.admin = () => ({ command: async () => { throw new Error('not authorized'); } });
    const report = await inspectRetention({ db, retentionDays: 30, now: NOW });
    assert.equal(report.facts.serverVersion, null);
});

test('the check only reads', async () => {
    const db = fakeDb({ indexes: ttl(30) });
    await inspectRetention({ db, retentionDays: 30, now: NOW });
    assert.deepEqual(db.writes, []);
});

test('the report says what it found in plain lines', async () => {
    const report = await inspectRetention({ db: fakeDb({ indexes: ttl(7) }), retentionDays: 30, now: NOW });
    const text = formatRetentionReport(report);
    assert.match(text, /Configured retention: 30 days/);
    assert.match(text, /Effective TTL:\s+7 days/);
    assert.match(text, /Problems found \(1\)/);
});
