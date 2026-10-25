// Run with: npm test
// What a host agent may send. The endpoint is open to anyone with a token, so nothing it sends is trusted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIngest, MAX_SNAPSHOTS, MAX_DISKS, MAX_PROCESSES, MAX_AGE_MS, MAX_AHEAD_MS } from '../utils/hostMetrics.js';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const GB = 1024 ** 3;

const snapshot = (extra = {}) => ({
    cpu: { percent: 37.456, cores: 4, load: [0.5, 0.75, 1.234] },
    mem: { total: 8 * GB, used: 3 * GB },
    swap: { total: 2 * GB, used: 0 },
    disks: [{ mount: '/', total: 100 * GB, used: 40 * GB }, { mount: '/data', total: 500 * GB, used: 120 * GB }],
    net: { rxBps: 1200, txBps: 800 },
    uptimeSec: 86400,
    procs: [{ name: 'node', cpu: 12.34, mem: 3.21 }, { name: 'postgres', cpu: 4, mem: 8 }],
    ...extra
});
const body = (snapshots = [snapshot()], extra = {}) => ({ v: 1, host: { name: 'web-1', os: 'linux', arch: 'amd64', agentVersion: '0.1.0' }, snapshots, ...extra });
const bad = (raw) => { const r = parseIngest(raw, NOW); assert.equal(r.ok, false, JSON.stringify(raw).slice(0, 120)); return r.issues; };

test('a good snapshot is accepted and stored in the shape the model keeps', () => {
    const r = parseIngest(body(), NOW);
    assert.equal(r.ok, true);
    assert.deepEqual(r.host, { name: 'web-1', os: 'linux', arch: 'amd64', agentVersion: '0.1.0' });
    assert.equal(r.points.length, 1);
    const p = r.points[0];
    assert.deepEqual(p.timestamp, new Date(NOW));
    assert.equal(p.cpu, 37.5);
    assert.equal(p.cores, 4);
    assert.deepEqual([p.load1, p.load5, p.load15], [0.5, 0.75, 1.23]);
    assert.equal(p.memUsed, 3 * GB);
    assert.equal(p.disks.length, 2);
    assert.deepEqual(p.procs, [{ name: 'node', cpu: 12.3, mem: 3.2 }, { name: 'postgres', cpu: 4, mem: 8 }]);
    assert.equal(p.rxBps, 1200);
});

test('only the parts that were sent are kept: no swap, network, load or processes is fine', () => {
    const lean = { cpu: { percent: 5, cores: 1 }, mem: { total: GB, used: 1 }, disks: [], uptimeSec: 5 };
    const r = parseIngest({ v: 1, snapshots: [lean] }, NOW);
    assert.equal(r.ok, true);
    for (const field of ['load1', 'swapTotal', 'rxBps', 'procs']) assert.equal(field in r.points[0], false, field);
    assert.deepEqual(r.host, {});
});

test('the server\'s clock decides when it happened, and the agent\'s is believed only when it is close', () => {
    const at = (offsetMs) => parseIngest(body([snapshot({ ts: new Date(NOW + offsetMs).toISOString() })]), NOW).points[0].timestamp.getTime();
    assert.equal(at(-5 * 60 * 1000), NOW - 5 * 60 * 1000, 'a replay after a short outage keeps its time');
    assert.equal(at(30 * 1000), NOW + 30 * 1000, 'a little drift ahead is allowed');
    assert.equal(at(-MAX_AGE_MS - 1000), NOW, 'too old: the time it arrived');
    assert.equal(at(MAX_AHEAD_MS + 1000), NOW, 'in the future: the time it arrived');
    assert.equal(parseIngest(body([snapshot({ ts: '2000-01-01T00:00:00Z' })]), NOW).points[0].timestamp.getTime(), NOW);
});

test('a buffered batch comes out in time order', () => {
    const t = (min) => new Date(NOW - min * 60000).toISOString();
    const r = parseIngest(body([snapshot({ ts: t(1) }), snapshot({ ts: t(3) }), snapshot({ ts: t(2) })]), NOW);
    assert.deepEqual(r.points.map((p) => NOW - p.timestamp.getTime()), [180000, 120000, 60000]);
});

test('the version, the list of snapshots and unknown fields are strict', () => {
    bad(null); bad('x'); bad([]); bad({});
    bad({ ...body(), v: 2 });
    bad({ ...body(), v: undefined });
    bad(body([]));
    bad(body(Array.from({ length: MAX_SNAPSHOTS + 1 }, () => snapshot())));
    bad({ ...body(), extra: 1 });
    bad(body([snapshot({ extra: 1 })]));
    bad(body([snapshot({ cpu: { percent: 1, cores: 1, extra: 1 } })]));
    bad(body([snapshot()], { host: { name: 'x', command: 'rm -rf /' } }));
    assert.equal(parseIngest(body(Array.from({ length: MAX_SNAPSHOTS }, () => snapshot())), NOW).ok, true);
});

test('every number has a range, and NaN, Infinity and wrong types are refused', () => {
    for (const percent of [-1, 100.1, NaN, Infinity, '50', null]) bad(body([snapshot({ cpu: { percent, cores: 2 } })]));
    for (const cores of [0, 1.5, 5000, '2', -1]) bad(body([snapshot({ cpu: { percent: 5, cores } })]));
    bad(body([snapshot({ mem: { total: -1, used: 0 } })]));
    bad(body([snapshot({ mem: { total: 1.5, used: 1 } })]));
    bad(body([snapshot({ mem: { total: 1e17, used: 1 } })]));
    bad(body([snapshot({ cpu: { percent: 5, cores: 2, load: [1, 2] } })]));
    bad(body([snapshot({ cpu: { percent: 5, cores: 2, load: [1, 2, -1] } })]));
    bad(body([snapshot({ uptimeSec: -1 })]));
    bad(body([snapshot({ net: { rxBps: -5, txBps: 0 } })]));
    bad(body([snapshot({ procs: [{ name: 'x', cpu: 1, mem: 101 }] })]));
});

test('used can never be more than total, for memory, swap and every disk', () => {
    bad(body([snapshot({ mem: { total: GB, used: GB + 1 } })]));
    bad(body([snapshot({ swap: { total: 0, used: 1 } })]));
    bad(body([snapshot({ disks: [{ mount: '/', total: 10, used: 11 }] })]));
});

test('lists are capped: disks and processes', () => {
    const disk = (i) => ({ mount: `/m${i}`, total: 10, used: 1 });
    assert.equal(parseIngest(body([snapshot({ disks: Array.from({ length: MAX_DISKS }, (_, i) => disk(i)) })]), NOW).ok, true);
    bad(body([snapshot({ disks: Array.from({ length: MAX_DISKS + 1 }, (_, i) => disk(i)) })]));
    const proc = (i) => ({ name: `p${i}`, cpu: 1, mem: 1 });
    assert.equal(parseIngest(body([snapshot({ procs: Array.from({ length: MAX_PROCESSES }, (_, i) => proc(i)) })]), NOW).ok, true);
    bad(body([snapshot({ procs: Array.from({ length: MAX_PROCESSES + 1 }, (_, i) => proc(i)) })]));
});

test('strings are short, non-empty and have no control characters', () => {
    bad(body([snapshot({ procs: [{ name: '', cpu: 1, mem: 1 }] })]));
    bad(body([snapshot({ procs: [{ name: 'x'.repeat(65), cpu: 1, mem: 1 }] })]));
    bad(body([snapshot({ procs: [{ name: 'bad\nname', cpu: 1, mem: 1 }] })]));
    bad(body([snapshot({ disks: [{ mount: '/a\u0000b', total: 10, used: 1 }] })]));
    bad(body([snapshot()], { host: { name: 'x'.repeat(65) } }));
    bad(body([snapshot()], { host: { agentVersion: 'v\u001b[31m' } }));
    assert.equal(parseIngest(body([snapshot({ procs: [{ name: 'C:\\Program Files\\x.exe', cpu: 1, mem: 1 }] })]), NOW).ok, true);
});

test('what is reported about a bad body never repeats what was sent, and is not unbounded', () => {
    const secret = 'sk_live_SUPERSECRET';
    const issues = bad(body([snapshot({ procs: [{ name: secret, cpu: 'x', mem: 1, token: secret }] })]));
    assert.ok(!JSON.stringify(issues).includes(secret));
    const many = bad(body(Array.from({ length: 10 }, () => snapshot({ cpu: { percent: 'x', cores: 'y' }, mem: 1, uptimeSec: 'z' }))));
    assert.ok(many.length <= 10);
    for (const issue of many) assert.deepEqual(Object.keys(issue).sort(), ['message', 'path']);
});
