// Run with: npm test
// Host snapshots into 5-minute rows, rows into chart steps, and what the page says about the agent.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BUCKET_MS, PERIODS, bucketStart, percentOf, pointFromRaw, rollupBucket, rollupRows, binPoints, longRangePoints,
    tailStart, latestOf, agentStatus, mountsOf, OFFLINE_AFTER_MS
} from '../utils/hostSeries.js';

const GB = 1024 ** 3;
const T0 = Date.parse('2026-10-26T12:00:00Z'); // a bucket boundary
const at = (min, sec = 0) => new Date(T0 + min * 60000 + sec * 1000);

const raw = (min, extra = {}) => ({
    serverId: 's1', timestamp: at(min), cpu: 40, cores: 2, load1: 0.5, load5: 0.6, load15: 0.7,
    memTotal: 4 * GB, memUsed: 1 * GB, swapTotal: 2 * GB, swapUsed: 0,
    disks: [{ mount: '/', total: 100 * GB, used: 40 * GB }], rxBps: 1000, txBps: 500, uptimeSec: 1000 + min * 60,
    procs: [{ name: 'node', cpu: 10, mem: 2 }], ...extra
});

test('a time falls in the 5-minute stretch it started in', () => {
    assert.equal(bucketStart(at(0)), T0);
    assert.equal(bucketStart(at(4, 59)), T0);
    assert.equal(bucketStart(at(5)), T0 + BUCKET_MS);
    assert.equal(bucketStart(at(-1)), T0 - BUCKET_MS);
});

test('percent is used over total, rounded, and 0 when there is nothing to measure', () => {
    assert.equal(percentOf(1, 3), 33.3);
    assert.equal(percentOf(0, 100), 0);
    for (const [used, total] of [[1, 0], [NaN, 5], [5, NaN], [undefined, undefined], [1, -5]]) assert.equal(percentOf(used, total), 0, `${used}/${total}`);
});

// ── rolling up ──

test('a stretch is the average of what is steady and the worst moment of what spikes', () => {
    const rows = [raw(0, { cpu: 10, memUsed: 1 * GB }), raw(1, { cpu: 90, memUsed: 3 * GB }), raw(2, { cpu: 20, memUsed: 2 * GB })];
    const r = rollupBucket(rows);
    assert.equal(r.n, 3);
    assert.equal(r.cpu, 40);
    assert.equal(r.cpuMax, 90);
    assert.equal(r.memPct, 50);
    assert.equal(r.memPctMax, 75);
    assert.equal(r.load1, 0.5);
    assert.equal(r.rxBps, 1000);
    assert.equal(r.swapPct, 0);
});

test('each disk is kept at its fullest, and the last uptime and memory size are kept', () => {
    const rows = [
        raw(0, { disks: [{ mount: '/', total: 100, used: 50 }, { mount: '/data', total: 200, used: 20 }] }),
        raw(1, { disks: [{ mount: '/', total: 100, used: 95 }, { mount: '/data', total: 200, used: 10 }] }),
        raw(2, { disks: [{ mount: '/', total: 100, used: 60 }] })
    ];
    const r = rollupBucket(rows);
    assert.deepEqual(r.disks, [{ mount: '/', total: 100, pct: 95 }, { mount: '/data', total: 200, pct: 10 }]);
    assert.equal(r.uptimeSec, rows[2].uptimeSec);
    assert.equal(r.memTotal, 4 * GB);
});

test('what an agent did not send is not in the row', () => {
    const lean = { serverId: 's1', timestamp: at(0), cpu: 5, memTotal: GB, memUsed: 1, disks: [], uptimeSec: 5 };
    const r = rollupBucket([lean]);
    for (const field of ['swapPct', 'load1', 'rxBps', 'txBps']) assert.equal(field in r, false, field);
    assert.deepEqual(r.disks, []);
});

test('snapshots from several servers and stretches become one row each, in time order', () => {
    const rows = [
        raw(7, { serverId: 'a' }), raw(1, { serverId: 'a' }), raw(2, { serverId: 'b' }), raw(3, { serverId: 'a' }), raw(12, { serverId: 'b' }), raw(11, { serverId: 'b' })
    ];
    const out = rollupRows(rows);
    assert.deepEqual(out.map((r) => [r.serverId, r.bucket.getTime() - T0, r.n]), [
        ['a', 0, 2], ['b', 0, 1], ['a', BUCKET_MS, 1], ['b', 2 * BUCKET_MS, 2]
    ]);
    assert.ok(out.every((r) => r.bucket instanceof Date));
});

test('rolling the same snapshots again gives the same rows, whatever order they arrive in', () => {
    const rows = [raw(0), raw(1, { cpu: 80 }), raw(2, { cpu: 10 }), raw(6)];
    const once = rollupRows(rows);
    const again = rollupRows([...rows].reverse());
    assert.deepEqual(again, once);
});

test('a late snapshot changes the row of the stretch it belongs to, nothing else', () => {
    const early = rollupRows([raw(0), raw(1)]);
    const withLate = rollupRows([raw(0), raw(1), raw(2, { cpu: 100 })]);
    assert.equal(early.length, 1);
    assert.equal(withLate[0].n, 3);
    assert.ok(withLate[0].cpuMax === 100 && early[0].cpuMax === 40);
});

// ── points ──

test('a raw snapshot becomes a point with percentages and the disks as they were', () => {
    const p = pointFromRaw(raw(0, { cpu: 12.34 }));
    assert.equal(p.t, T0);
    assert.equal(p.n, 1);
    assert.equal(p.cpu, 12.3);
    assert.equal(p.cpuMax, 12.3);
    assert.equal(p.memPct, 25);
    assert.equal(p.swapPct, 0);
    assert.deepEqual(p.disks, [{ mount: '/', pct: 40 }]);
    assert.equal(pointFromRaw({ timestamp: at(0), cpu: 1, memTotal: 1, memUsed: 0, disks: [] }).swapPct, null);
});

test('steps average by how many snapshots each point stands for, and keep the worst moment and the fullest disk', () => {
    const points = [
        { t: T0, n: 5, cpu: 10, cpuMax: 50, memPct: 20, memPctMax: 30, swapPct: null, load1: 1, rxBps: 100, txBps: 0, disks: [{ mount: '/', pct: 40 }] },
        { t: T0 + BUCKET_MS, n: 1, cpu: 70, cpuMax: 95, memPct: 80, memPctMax: 85, swapPct: null, load1: 4, rxBps: 700, txBps: 0, disks: [{ mount: '/', pct: 45 }, { mount: '/x', pct: 5 }] }
    ];
    const [step] = binPoints(points, 30 * 60000);
    assert.equal(step.n, 6);
    assert.equal(step.cpu, 20, '(10×5 + 70×1) / 6');
    assert.equal(step.cpuMax, 95);
    assert.equal(step.memPct, 30);
    assert.equal(step.memPctMax, 85);
    assert.equal(step.load1, 1.5);
    assert.equal(step.rxBps, 200);
    assert.equal(step.swapPct, null);
    assert.deepEqual(step.disks, [{ mount: '/', pct: 45 }, { mount: '/x', pct: 5 }]);
    assert.equal(step.t, T0);
});

test('steps start on their own boundary, come out in order, and no step means the points as they are', () => {
    const p = (min) => ({ t: T0 + min * 60000, n: 1, cpu: min, cpuMax: min, memPct: 1, memPctMax: 1, swapPct: null, load1: null, rxBps: null, txBps: null, disks: [] });
    const out = binPoints([p(0), p(10), p(29), p(31), p(61)], 30 * 60000);
    assert.deepEqual(out.map((s) => (s.t - T0) / 60000), [0, 30, 60]);
    const same = [p(0), p(1)];
    assert.equal(binPoints(same, 0), same);
});

test('every range stays within a few hundred points', () => {
    for (const [name, { rangeMs, binMs, source }] of Object.entries(PERIODS)) {
        const count = binMs ? rangeMs / binMs : rangeMs / 60000;
        assert.ok(count <= 400, `${name}: ${count} points`);
        assert.ok(source === 'raw' ? binMs === 0 : binMs >= BUCKET_MS, name);
    }
});

// ── a long range: stored rows, plus what has come in since ──

test('a long range reads the stored rows and adds the snapshots after the last of them', () => {
    const stored = rollupRows([raw(0), raw(1), raw(5), raw(6)]); // two buckets
    const tailRows = [raw(10, { cpu: 100 }), raw(11, { cpu: 100 })]; // the bucket that is not rolled yet
    assert.equal(tailStart(stored, T0 - 1), T0 + 2 * BUCKET_MS);

    const points = longRangePoints(stored, tailRows, BUCKET_MS);
    assert.deepEqual(points.map((p) => (p.t - T0) / BUCKET_MS), [0, 1, 2]);
    assert.equal(points[2].cpu, 100);
    assert.equal(points[2].n, 2);
});

test('with nothing rolled yet, the tail starts at the beginning of the range and the chart still has points', () => {
    assert.equal(tailStart([], 12345), 12345);
    const points = longRangePoints([], [raw(0), raw(1)], BUCKET_MS);
    assert.equal(points.length, 1);
    assert.equal(points[0].n, 2);
});

test('nothing at all is an empty chart, not an error', () => {
    assert.deepEqual(longRangePoints([], [], BUCKET_MS), []);
    assert.deepEqual(mountsOf([]), []);
});

// ── now, and the agent ──

test('the latest reading is given in full, with what is missing as null', () => {
    const l = latestOf(raw(3));
    assert.equal(l.t, at(3).getTime());
    assert.deepEqual(l.load, [0.5, 0.6, 0.7]);
    assert.deepEqual(l.mem, { used: GB, total: 4 * GB, pct: 25 });
    assert.deepEqual(l.disks, [{ mount: '/', total: 100 * GB, used: 40 * GB, pct: 40 }]);
    assert.deepEqual(l.procs, [{ name: 'node', cpu: 10, mem: 2 }]);
    assert.equal(latestOf(null), null);

    const lean = latestOf({ timestamp: at(0), cpu: 5, memTotal: GB, memUsed: 1, disks: [] });
    assert.deepEqual([lean.load, lean.swap, lean.rxBps, lean.uptimeSec, lean.procs], [null, null, null, null, []]);
});

test('the agent is off, waiting for its first snapshot, connected, or offline', () => {
    const now = T0;
    assert.equal(agentStatus(undefined, now), 'off');
    assert.equal(agentStatus({ enabled: false, lastSeenAt: at(-1) }, now), 'off');
    assert.equal(agentStatus({ enabled: true }, now), 'waiting');
    assert.equal(agentStatus({ enabled: true, lastSeenAt: new Date(now - 30000) }, now), 'connected');
    assert.equal(agentStatus({ enabled: true, lastSeenAt: new Date(now - OFFLINE_AFTER_MS) }, now), 'connected', 'on the line is still connected');
    assert.equal(agentStatus({ enabled: true, lastSeenAt: new Date(now - OFFLINE_AFTER_MS - 1000) }, now), 'offline');
});

test('the mounts of a series are listed once, in the order they first appear', () => {
    const p = (...mounts) => ({ disks: mounts.map((mount) => ({ mount, pct: 1 })) });
    assert.deepEqual(mountsOf([p('/'), p('/', '/data'), p('/data', '/var')]), ['/', '/data', '/var']);
});
