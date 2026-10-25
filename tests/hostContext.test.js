// Run with: npm test
// The host agent's readings as evidence for a failed check: what is worth citing, what is ruled out, and that nothing
// changes when there are no readings (or the plan does not include the detail).

import test from 'node:test';
import assert from 'node:assert/strict';
import { summariseHost, hostFindings, LIMITS } from '../utils/hostContext.js';
import { diagnoseDetailed } from '../utils/diagnosisDetail.js';
import { failureView } from '../utils/failureDetail.js';
import { hostContextFor } from '../services/hostContext.js';
import { buildIncidentList } from '../utils/incidentList.js';

const AT = Date.parse('2026-03-01T12:00:00Z');
const GB = 1024 ** 3;
const row = (minutesBefore, over = {}) => ({
    timestamp: new Date(AT - minutesBefore * 60000),
    cpu: 20,
    memTotal: 8 * GB,
    memUsed: 2 * GB,
    disks: [{ mount: '/', total: 100 * GB, used: 40 * GB }],
    procs: [{ name: 'node', cpu: 12, mem: 3 }],
    ...over
});
const series = (over = {}) => [8, 6, 4, 2, 1].map((m) => row(m, over));
const failure = { kind: 'http', statusCode: 504, error: 'Gateway Timeout', failedPhase: 'response', url: 'https://shop.example.com', type: 'website' };

test('summariseHost: averages the window, takes the newest memory and fullest disk', () => {
    const host = summariseHost([row(8, { cpu: 90 }), row(4, { cpu: 100 }), row(1, { cpu: 80, memUsed: 4 * GB })], AT);
    assert.equal(host.samples, 3);
    assert.equal(host.cpuAvg, 90);
    assert.equal(host.cpuMax, 100);
    assert.equal(host.memPct, 50);
    assert.deepEqual(host.disk, { mount: '/', pct: 40 });
    assert.deepEqual(host.proc, { name: 'node', cpu: 12 });
});

test('summariseHost: ignores readings outside the window, and says nothing from too few', () => {
    assert.equal(summariseHost([row(1)], AT), null);
    assert.equal(summariseHost([row(30), row(25), row(20)], AT), null, 'all before the window');
    assert.equal(summariseHost([row(-5), row(-6)], AT), null, 'all after the window');
    assert.equal(summariseHost([row(30, { cpu: 100 }), row(3), row(1)], AT).cpuMax, 20, 'old spike is not counted');
});

test('summariseHost: skips malformed rows and bad input', () => {
    assert.equal(summariseHost(null, AT), null);
    assert.equal(summariseHost(series(), 'not a date'), null);
    const host = summariseHost([row(3), { timestamp: 'x', cpu: 1 }, null, row(2, { cpu: 'high' }), row(1)], AT);
    assert.equal(host.samples, 2);
});

test('hostFindings: cpu, memory and disk, with the figures as evidence', () => {
    const busy = summariseHost(series({ cpu: 97, memUsed: 7.6 * GB, disks: [{ mount: '/var', total: 100 * GB, used: 98 * GB }] }), AT);
    const found = hostFindings(busy);
    assert.deepEqual(found.map((f) => f.kind).sort(), ['cpu', 'disk', 'memory']);
    assert.ok(found.every((f) => f.severe));
    assert.match(found.find((f) => f.kind === 'cpu').evidence[0], /averaged 97% and peaked at 97%/);
    assert.match(found.find((f) => f.kind === 'disk').evidence[0], /\/var was 98% full/);
});

test('hostFindings: a brief spike is not severe, and normal readings find nothing', () => {
    const spike = summariseHost([row(8), row(6), row(4, { cpu: 99 }), row(2), row(1)], AT);
    const [only] = hostFindings(spike);
    assert.equal(only.kind, 'cpu');
    assert.equal(only.severe, false);
    assert.deepEqual(hostFindings(summariseHost(series(), AT)), []);
    assert.deepEqual(hostFindings(null), []);
    assert.ok(LIMITS.cpuMax > LIMITS.cpuAvg);
});

test('diagnosis: a 504 during a CPU spike cites it and ranks it first', () => {
    const host = summariseHost(series({ cpu: 98 }), AT);
    const d = diagnoseDetailed({ ...failure, host });
    assert.equal(d.causes[0].confidence, 'high');
    assert.match(d.causes[0].text, /out of CPU/);
    assert.match(d.causes[0].evidence[0], /98%/);
    assert.ok(d.checks.some((c) => c.command === 'ps aux --sort=-%cpu | head -n 8'));
    assert.equal(d.hostNote, undefined);
    assert.ok(d.causes.length <= 4 && d.checks.length <= 6);
});

test('diagnosis: with no readings it reads exactly as before', () => {
    const without = diagnoseDetailed(failure);
    assert.deepEqual(diagnoseDetailed({ ...failure, host: null }), without);
    assert.equal('hostNote' in without, false);
});

test('diagnosis: a healthy host is a note, not a cause, and rules out exhaustion', () => {
    const d = diagnoseDetailed({ ...failure, host: summariseHost(series(), AT) });
    assert.match(d.hostNote, /looked normal/);
    assert.match(d.hostNote, /CPU 20%, memory 25%, \/ 40% full/);
    assert.ok(!d.causes.some((c) => /out of CPU|short of memory|almost full/.test(c.text)));
});

test('diagnosis: host evidence is only cited where it can explain the failure', () => {
    const host = summariseHost(series({ cpu: 99 }), AT);
    for (const f of [
        { kind: 'http', statusCode: 404, failedPhase: 'response' },
        { kind: 'http', statusCode: 403, failedPhase: 'response' },
        { kind: 'dns', failedPhase: 'dns', error: 'ENOTFOUND' },
        { kind: 'tls', failedPhase: 'tls', error: 'certificate has expired' }
    ]) {
        const d = diagnoseDetailed({ url: 'https://shop.example.com', type: 'website', error: f.error ?? 'x', ...f, host });
        assert.ok(!d.causes.some((c) => /out of CPU/.test(c.text)), JSON.stringify(f));
        assert.equal(d.hostNote, undefined);
    }
    const down = diagnoseDetailed({ kind: 'refused', failedPhase: 'connect', error: 'ECONNREFUSED', url: 'https://shop.example.com', type: 'website', host });
    assert.ok(down.causes.some((c) => /out of CPU/.test(c.text)), 'a refused connection can be an overloaded host');
});

test('failureView: the host is used on a plan with the detail and ignored on one without', () => {
    const host = summariseHost(series({ cpu: 98 }), AT);
    const args = { failure: { kind: 'http', statusCode: 504, error: 'Gateway Timeout', failedPhase: 'response' }, server: { url: 'https://shop.example.com', type: 'website' }, host };
    assert.match(failureView({ ...args, detailed: true }).diagnosis.causes[0].text, /out of CPU/);
    const free = failureView({ ...args, detailed: false }).diagnosis;
    assert.equal('causes' in free, false);
    assert.equal(JSON.stringify(free).includes('98'), false, 'nothing from the host reaches a plan without the detail');
});

test('hostContextFor: asks for the window around the failure and summarises it', async () => {
    let asked;
    const find = async (serverId, from, to) => { asked = { serverId, from, to }; return series({ cpu: 96 }); };
    const host = await hostContextFor({ serverId: 'abc', at: AT }, { find });
    assert.equal(asked.serverId, 'abc');
    assert.equal(asked.from.getTime(), AT - 10 * 60000);
    assert.equal(asked.to.getTime(), AT + 60000);
    assert.equal(host.cpuAvg, 96);
});

test('hostContextFor: never throws, and gives nothing for bad input or a failing read', async () => {
    assert.equal(await hostContextFor({ serverId: 'abc', at: AT }, { find: async () => { throw new Error('timed out'); } }), null);
    assert.equal(await hostContextFor({ serverId: 'abc', at: null }, { find: async () => series() }), null);
    assert.equal(await hostContextFor({ serverId: null, at: AT }, { find: async () => series() }), null);
    assert.equal(await hostContextFor({ serverId: 'abc', at: AT }, { find: async () => [] }), null);
});

test('incident list: an incident gets the host readings keyed by its id', () => {
    const incident = { _id: 'i1', serverId: 's1', startedAt: new Date(AT - 60000), open: true, failureKind: 'http', statusCode: 504, error: 'Gateway Timeout', failedPhase: 'response' };
    const servers = [{ _id: 's1', name: 'Shop', url: 'https://shop.example.com', type: 'website' }];
    const hosts = new Map([['i1', summariseHost(series({ cpu: 98 }), AT)]]);
    const withHost = buildIncidentList([incident], servers, { detailed: true, hosts, now: AT });
    assert.match(withHost.incidents[0].diagnosis.causes[0].text, /out of CPU/);
    const without = buildIncidentList([incident], servers, { detailed: true, now: AT });
    assert.ok(!without.incidents[0].diagnosis.causes.some((c) => /out of CPU/.test(c.text)));
});
