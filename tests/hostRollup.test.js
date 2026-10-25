// Run with: npm test
// The 5-minute rollup job: which stretches it rolls, how it catches up, and that doing it twice changes nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runHostRollup, catchUpHostRollup, LOOKBACK_BUCKETS } from '../tasks/hostRollup.js';
import { BUCKET_MS } from '../utils/hostSeries.js';
import HostMetric from '../models/HostMetric.js';
import HostMetric5m, { ROLLUP_RETENTION_SECONDS } from '../models/HostMetric5m.js';

const GB = 1024 ** 3;
const HOUR = 60 * 60 * 1000;
const BOUNDARY = Date.parse('2026-10-26T12:00:00Z');
const NOW = BOUNDARY + 70 * 1000; // the job runs a minute after the boundary

const snap = (ms, serverId = 's1', cpu = 40) => ({
    serverId, timestamp: new Date(ms), cpu, memTotal: 4 * GB, memUsed: GB, disks: [{ mount: '/', total: 100, used: 10 }], uptimeSec: 100
});

/** A fake store: raw snapshots, and rolled rows keyed the way the unique index keys them */
const store = (raw = [], rolled = []) => {
    const rows = new Map(rolled.map((r) => [`${r.serverId}|${r.bucket.getTime()}`, r]));
    const reads = [];
    return {
        rows,
        reads,
        deps: {
            now: () => NOW,
            readRaw: async (from, to) => { reads.push([from.getTime(), to.getTime()]); return raw.filter((r) => r.timestamp >= from && r.timestamp < to); },
            upsertRows: async (list) => { for (const r of list) rows.set(`${r.serverId}|${r.bucket.getTime()}`, r); },
            newestRolled: async () => (rolled.length ? new Date(Math.max(...rolled.map((r) => r.bucket.getTime()))) : null)
        }
    };
};

test('the regular run rolls the finished stretches of the last four, and never the one still filling', async () => {
    const raw = [
        snap(BOUNDARY - 21 * 60000), // 5 buckets back: before the window
        snap(BOUNDARY - 19 * 60000), snap(BOUNDARY - 9 * 60000), snap(BOUNDARY - 1 * 60000),
        snap(BOUNDARY + 30 * 1000) // the stretch that has just begun
    ];
    const s = store(raw);
    const result = await runHostRollup(s.deps);

    assert.deepEqual(s.reads, [[BOUNDARY - LOOKBACK_BUCKETS * BUCKET_MS, BOUNDARY]]);
    assert.equal(result.rows, 3);
    assert.deepEqual([...s.rows.values()].map((r) => (r.bucket.getTime() - BOUNDARY) / 60000).sort((a, b) => a - b), [-20, -10, -5]);
});

test('an agent that sends what it kept while offline lands in the stretch it belongs to, on the next run', async () => {
    const raw = [snap(BOUNDARY - 9 * 60000, 's1', 10)];
    const s = store(raw);
    await runHostRollup(s.deps);
    const before = [...s.rows.values()].find((r) => r.bucket.getTime() === BOUNDARY - 10 * 60000);
    assert.equal(before.n, 1);

    raw.push(snap(BOUNDARY - 8 * 60000, 's1', 90)); // arrives late, with the time it was taken
    await runHostRollup(s.deps);
    const after = [...s.rows.values()].find((r) => r.bucket.getTime() === BOUNDARY - 10 * 60000);
    assert.equal(after.n, 2);
    assert.equal(after.cpuMax, 90);
    assert.equal(s.rows.size, 1, 'the same row, rewritten');
});

test('running it twice, or two processes at once, leaves the same rows', async () => {
    const raw = [snap(BOUNDARY - 9 * 60000), snap(BOUNDARY - 8 * 60000), snap(BOUNDARY - 3 * 60000, 's2')];
    const s = store(raw);
    await Promise.all([runHostRollup(s.deps), runHostRollup(s.deps)]);
    const once = JSON.stringify([...s.rows.entries()].sort());
    await runHostRollup(s.deps);
    assert.equal(JSON.stringify([...s.rows.entries()].sort()), once);
    assert.equal(s.rows.size, 2);
});

test('with nothing to roll nothing is written', async () => {
    let writes = 0;
    const s = store([]);
    const result = await runHostRollup({ ...s.deps, upsertRows: async () => { writes += 1; } });
    assert.equal(result.rows, 0);
    assert.equal(writes, 0);
});

test('catching up starts from the newest stored stretch, in chunks of an hour, up to the last finished one', async () => {
    const newest = BOUNDARY - 3 * HOUR;
    const raw = [snap(newest + 60000), snap(BOUNDARY - 2 * HOUR + 60000), snap(BOUNDARY - 10 * 60000)];
    const s = store(raw, [{ serverId: 's1', bucket: new Date(newest), n: 1 }]);
    const result = await catchUpHostRollup(s.deps);

    assert.deepEqual(s.reads, [
        [newest, newest + HOUR], [newest + HOUR, newest + 2 * HOUR], [newest + 2 * HOUR, BOUNDARY]
    ]);
    assert.equal(result.chunks, 3);
    assert.equal(result.rows, 3);
});

test('catching up with nothing stored goes back as far as raw snapshots are kept, and no further', async () => {
    const s = store([snap(BOUNDARY - 23 * HOUR)]);
    const result = await catchUpHostRollup(s.deps);
    assert.equal(s.reads[0][0], Math.floor((NOW - 24 * HOUR) / BUCKET_MS) * BUCKET_MS);
    assert.equal(s.reads.at(-1)[1], BOUNDARY);
    assert.equal(result.rows, 1);
    assert.ok(s.reads.length >= 23 && s.reads.length <= 25);
});

test('catching up when there is nothing to catch up on reads nothing it does not need', async () => {
    const s = store([], [{ serverId: 's1', bucket: new Date(BOUNDARY - BUCKET_MS), n: 1 }]);
    const result = await catchUpHostRollup(s.deps);
    assert.equal(result.rows, 0);
    assert.ok(s.reads.length <= 1);
});

// ── how it is stored ──

test('rows are unique per server and stretch, and expire after 30 days', () => {
    const indexes = HostMetric5m.schema.indexes();
    const unique = indexes.find(([keys]) => keys.serverId === 1 && keys.bucket === 1);
    assert.equal(unique[1].unique, true);
    const ttl = indexes.find(([keys]) => keys.bucket === 1 && !('serverId' in keys));
    assert.equal(ttl[1].expireAfterSeconds, ROLLUP_RETENTION_SECONDS);
    assert.equal(ROLLUP_RETENTION_SECONDS, 30 * 24 * 60 * 60);
});

test('raw snapshots expire after 24 hours and can be read by time across servers', () => {
    assert.equal(HostMetric.schema.options.expireAfterSeconds, 24 * 60 * 60);
    assert.ok(HostMetric.schema.indexes().some(([keys]) => keys.timestamp === 1 && Object.keys(keys).length === 1));
});

// ── what happens when a server or an account goes ──
// These paths use the real database models, so they are checked in the source: a regression that drops the clean-up
// would otherwise leave a customer's host data behind with nothing to notice it.

test('deleting a server and deleting an account both clear the raw and the rolled-up host metrics', () => {
    const server = fs.readFileSync(new URL('../controllers/serverController.js', import.meta.url), 'utf8');
    const account = fs.readFileSync(new URL('../services/accountCleanup.js', import.meta.url), 'utf8');
    for (const [name, source] of [['deleteServer', server], ['purgeUserData', account]]) {
        assert.match(source, /HostMetric\.deleteMany\(/, `${name} clears raw snapshots`);
        assert.match(source, /HostMetric5m\.deleteMany\(/, `${name} clears the rolled-up rows`);
    }
    assert.match(account, /HostMetric\.deleteMany\(\{ serverId: \{ \$in: serverIds \} \}\)/, 'for every one of the account\'s servers');
});
