// Run with: npm test
// When a host's numbers are worth an alert, and what the alert says.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULTS, HYSTERESIS, GAP_MS, hostAlertSettings, evaluateSnapshots, missingDecision, markMissing, cleanHostAlert, hostAlertText,
    HOST_ALERT_TYPES, isHostAlert
} from '../utils/hostAlerts.js';

const GB = 1024 ** 3;
const T0 = Date.parse('2026-10-26T12:00:00Z');
const MIN = 60 * 1000;

const point = (min, extra = {}) => ({
    timestamp: new Date(T0 + min * MIN), cpu: 10, memTotal: 8 * GB, memUsed: 2 * GB,
    disks: [{ mount: '/', total: 100 * GB, used: 40 * GB }], procs: [], ...extra
});
const cpu = (min, value, extra = {}) => point(min, { cpu: value, ...extra });
const settings = (over = {}) => hostAlertSettings(over);

/** Feed readings one minute apart through the evaluator, carrying the state like the server does */
const run = (points, { s = settings(), state = {}, canAlert = true, previousSeenAt = null } = {}) => {
    let current = state;
    let last = previousSeenAt;
    const all = [];
    for (const p of points) {
        const { state: next, events } = evaluateSnapshots({ settings: s, state: current, points: [p], previousSeenAt: last, canAlert });
        current = next;
        last = new Date(p.timestamp).getTime();
        all.push(...events);
    }
    return { state: current, events: all };
};

// ── the settings ──

test('with nothing saved the defaults apply', () => {
    assert.deepEqual(hostAlertSettings(undefined), DEFAULTS);
    assert.deepEqual(hostAlertSettings({}), DEFAULTS);
    assert.deepEqual(hostAlertSettings(null), DEFAULTS);
    assert.equal(DEFAULTS.cpu.percent, 90);
    assert.equal(DEFAULTS.cpu.minutes, 5);
    assert.equal(DEFAULTS.missing.minutes, 5);
});

test('what the owner saved wins, a missing part keeps its default, and every number stays in range', () => {
    const s = hostAlertSettings({ cpu: { percent: 80 }, memory: { minutes: 10 }, disk: { percent: 95, minutes: 0 }, missing: { minutes: 15 } });
    assert.deepEqual(s.cpu, { percent: 80, minutes: 5 });
    assert.deepEqual(s.memory, { percent: 90, minutes: 10 });
    assert.deepEqual(s.disk, { percent: 95, minutes: 0 });
    assert.equal(s.missing.minutes, 15);
    const wild = hostAlertSettings({ cpu: { percent: 5000, minutes: -4 }, memory: { percent: 0, minutes: 9999 }, missing: { minutes: 0 } });
    assert.deepEqual(wild.cpu, { percent: 100, minutes: 0 });
    assert.deepEqual(wild.memory, { percent: 1, minutes: 60 });
    assert.equal(wild.missing.minutes, 2, 'at least two minutes: the agent reports once a minute');
});

test('odd saved values fall back to the default rather than switching an alert off', () => {
    for (const odd of ['x', 5, [], { cpu: 'high', memory: { percent: 'a', minutes: null }, missing: 7 }]) {
        const s = hostAlertSettings(odd);
        assert.deepEqual([s.cpu, s.memory, s.disk, s.missing.minutes], [DEFAULTS.cpu, DEFAULTS.memory, DEFAULTS.disk, DEFAULTS.missing.minutes], JSON.stringify(odd));
    }
    assert.equal(hostAlertSettings({ enabled: false }).enabled, false);
    assert.equal(hostAlertSettings({ enabled: 'no' }).enabled, true, 'only an explicit false turns them off');
});

// ── over the limit for a while ──

test('CPU over the limit raises one alert, once it has stayed there for the whole duration', () => {
    const readings = Array.from({ length: 12 }, (_, i) => cpu(i, 97));
    const { events } = run(readings);
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.type, 'host_cpu_high');
    assert.equal(e.recovered, false);
    assert.equal(e.value, 97);
    assert.equal(e.threshold, 90);
    assert.equal(e.minutes, 5);
    assert.equal(e.since, new Date(T0).toISOString(), 'since the first reading over the limit');
    assert.equal(new Date(readings[5].timestamp) - new Date(e.since), 5 * MIN);
});

test('it fires at the reading that completes the duration, not before', () => {
    const fired = [];
    let state = {};
    let last = null;
    for (let i = 0; i < 8; i += 1) {
        const p = cpu(i, 95);
        const r = evaluateSnapshots({ settings: settings(), state, points: [p], previousSeenAt: last });
        state = r.state;
        last = T0 + i * MIN;
        if (r.events.length) fired.push(i);
    }
    assert.deepEqual(fired, [5]);
});

test('a spike shorter than the duration raises nothing', () => {
    const values = [10, 99, 99, 99, 10, 10, 99, 99, 10, 10];
    assert.deepEqual(run(values.map((v, i) => cpu(i, v))).events, []);
});

test('a dip under the limit by more than the margin starts the clock again', () => {
    // 4 minutes over, a real drop, then 4 more over: never 5 in a row
    const values = [95, 95, 95, 95, 60, 95, 95, 95, 95];
    assert.deepEqual(run(values.map((v, i) => cpu(i, v))).events, []);
});

test('a reading just under the limit neither fires nor resets the clock', () => {
    // 88 is under 90 but inside the margin: the five minutes keep counting
    const values = [95, 95, 95, 88, 95, 95, 95];
    const { events } = run(values.map((v, i) => cpu(i, v)));
    assert.equal(events.length, 1);
});

test('a value hovering around the limit raises one alert, not one per crossing', () => {
    const values = [95, 95, 95, 95, 95, 95, 89, 92, 88, 96, 87, 93, 89, 95];
    const { events } = run(values.map((v, i) => cpu(i, v)));
    assert.equal(events.length, 1);
    assert.equal(events[0].recovered, false);
});

test('it ends when the value is the margin under the limit, and says how long it lasted', () => {
    const over = Array.from({ length: 8 }, (_, i) => cpu(i, 96));
    const after = [cpu(8, 91), cpu(9, 90 - HYSTERESIS + 1), cpu(10, 90 - HYSTERESIS)];
    const { events, state } = run([...over, ...after]);
    assert.equal(events.length, 2);
    const [start, end] = events;
    assert.equal(start.recovered, false);
    assert.equal(end.recovered, true);
    assert.equal(end.value, 85);
    assert.equal(end.lasted, 5, 'five minutes from the alert at minute 5 to the end at minute 10');
    assert.equal(state.cpu.alerted, false);
});

test('after it has ended a new breach raises a new alert', () => {
    const first = Array.from({ length: 7 }, (_, i) => cpu(i, 96));
    const calm = [cpu(7, 10)];
    const second = Array.from({ length: 7 }, (_, i) => cpu(8 + i, 96));
    const { events } = run([...first, ...calm, ...second]);
    assert.deepEqual(events.map((e) => e.recovered), [false, true, false]);
});

test('memory is judged as a percentage of the machine\'s memory', () => {
    const readings = Array.from({ length: 8 }, (_, i) => point(i, { memUsed: 7.5 * GB })); // 93.8%
    const { events } = run(readings);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'host_memory_high');
    assert.equal(events[0].value, 93.8);
});

test('each metric has its own clock and its own alert', () => {
    const readings = Array.from({ length: 8 }, (_, i) => point(i, { cpu: 97, memUsed: 7.6 * GB }));
    assert.deepEqual(run(readings).events.map((e) => e.type).sort(), ['host_cpu_high', 'host_memory_high']);
});

test('what is using the CPU, and the memory, is in the alert, busiest first and by name only', () => {
    const procs = [{ name: 'cron', cpu: 1, mem: 0.1 }, { name: 'node', cpu: 85, mem: 20 }, { name: 'postgres', cpu: 40, mem: 30 }, { name: 'nginx', cpu: 5, mem: 2 }, { name: 'sshd', cpu: 0, mem: 0 }];
    const cpuEvents = run(Array.from({ length: 7 }, (_, i) => cpu(i, 97, { procs }))).events;
    assert.deepEqual(cpuEvents[0].procs.map((p) => p.name), ['node', 'postgres', 'nginx']);
    const memEvents = run(Array.from({ length: 7 }, (_, i) => point(i, { memUsed: 7.6 * GB, procs }))).events;
    assert.deepEqual(memEvents[0].procs.map((p) => p.name), ['postgres', 'node', 'nginx']);
});

// ── disk ──

test('the disk that is fullest is the one judged, and the alert names it', () => {
    const disks = [{ mount: '/', total: 100 * GB, used: 50 * GB }, { mount: '/data', total: 500 * GB, used: 480 * GB }];
    const { events } = run(Array.from({ length: 4 }, (_, i) => point(i, { disks })));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'host_disk_high');
    assert.equal(events[0].mount, '/data');
    assert.equal(events[0].value, 96);
    assert.equal(events[0].minutes, 2);
});

test('with no duration a disk alerts on the first reading over the limit', () => {
    const s = settings({ disk: { percent: 90, minutes: 0 } });
    const { events } = run([point(0, { disks: [{ mount: '/', total: 100, used: 95 }] })], { s });
    assert.equal(events.length, 1);
});

test('a disk alert ends when every disk is under the limit by the margin', () => {
    const full = [{ mount: '/', total: 100, used: 95 }];
    const roomy = [{ mount: '/', total: 100, used: 70 }];
    const { events } = run([point(0, { disks: full }), point(1, { disks: full }), point(2, { disks: full }), point(3, { disks: roomy })]);
    assert.deepEqual(events.map((e) => [e.recovered, e.mount]), [[false, '/'], [true, '/']]);
});

test('readings with no disks, or a metric with no data, are skipped without error', () => {
    const { events } = run([point(0, { disks: [] }), point(1, { disks: undefined }), point(2, { cpu: NaN })]);
    assert.deepEqual(events, []);
});

// ── time nobody was watching ──

test('time the agent was not reporting does not count towards the duration', () => {
    // 4 minutes over, then an hour of silence, then one reading over: that is not "over for 5 minutes"
    const before = Array.from({ length: 4 }, (_, i) => cpu(i, 97));
    const { events, state } = run([...before, cpu(65, 97)]);
    assert.deepEqual(events, []);
    assert.equal(state.cpu.since, T0 + 65 * MIN, 'the clock restarted after the gap');
});

test('a gap between batches counts the same way: the last time seen is where the last batch ended', () => {
    const first = evaluateSnapshots({ settings: settings(), state: {}, points: [cpu(0, 97), cpu(1, 97)], previousSeenAt: null });
    const second = evaluateSnapshots({ settings: settings(), state: first.state, points: [cpu(61, 97), cpu(62, 97)], previousSeenAt: T0 + MIN });
    assert.deepEqual(second.events, []);
    assert.ok(61 * MIN > GAP_MS);
});

test('an alert that is open stays open across a gap, and ends normally when the value drops', () => {
    const over = Array.from({ length: 7 }, (_, i) => cpu(i, 97));
    const { events } = run([...over, cpu(100, 10)]);
    assert.deepEqual(events.map((e) => e.recovered), [false, true]);
});

test('readings arriving in a batch are judged in time order, whatever order they come in', () => {
    const readings = Array.from({ length: 8 }, (_, i) => cpu(i, 97));
    const shuffled = [readings[3], readings[7], readings[0], readings[5], readings[1], readings[6], readings[2], readings[4]];
    const batch = evaluateSnapshots({ settings: settings(), state: {}, points: shuffled, previousSeenAt: null });
    assert.equal(batch.events.length, 1);
    assert.equal(batch.events[0].since, new Date(T0).toISOString());
});

// ── when the owner cannot be told ──

test('when the owner cannot be told now nothing is raised and nothing is used up', () => {
    const readings = Array.from({ length: 10 }, (_, i) => cpu(i, 97));
    const quiet = run(readings, { canAlert: false });
    assert.deepEqual(quiet.events, []);
    assert.equal(quiet.state.cpu.alerted, false);
    assert.equal(quiet.state.cpu.since, T0, 'the clock kept running');

    // the first reading after they can be told raises it at once, since it has been over for long enough
    const later = evaluateSnapshots({ settings: settings(), state: quiet.state, points: [cpu(10, 97)], previousSeenAt: T0 + 9 * MIN });
    assert.equal(later.events.length, 1);
});

test('an end that cannot be told yet is told later', () => {
    const over = run(Array.from({ length: 7 }, (_, i) => cpu(i, 97)));
    const muted = evaluateSnapshots({ settings: settings(), state: over.state, points: [cpu(7, 10)], previousSeenAt: T0 + 6 * MIN, canAlert: false });
    assert.deepEqual(muted.events, []);
    assert.equal(muted.state.cpu.alerted, true, 'still open');
    const told = evaluateSnapshots({ settings: settings(), state: muted.state, points: [cpu(8, 10)], previousSeenAt: T0 + 7 * MIN });
    assert.deepEqual(told.events.map((e) => e.recovered), [true]);
});

test('with the alerts switched off nothing is raised and the state is left alone', () => {
    const state = { cpu: { since: T0, alerted: true } };
    const r = evaluateSnapshots({ settings: settings({ enabled: false }), state, points: [cpu(0, 99), cpu(10, 99)] });
    assert.deepEqual(r.events, []);
    assert.deepEqual(r.state, state);
});

test('the state in is never changed, and what comes back is plain data', () => {
    const state = { cpu: { since: T0, alerted: false } };
    const frozen = JSON.stringify(state);
    const r = evaluateSnapshots({ settings: settings(), state, points: [cpu(0, 50)] });
    assert.equal(JSON.stringify(state), frozen);
    assert.deepEqual(JSON.parse(JSON.stringify(r.state)), r.state);
});

// ── the agent going quiet ──

const now = T0 + 20 * MIN;
const agent = (over = {}) => ({ enabled: true, lastSeenAt: new Date(T0), ...over });

test('an agent quiet for the set time is reported, with how long and when it was last heard', () => {
    const d = missingDecision({ settings: settings(), agent: agent(), now });
    assert.equal(d.type, 'host_metrics_missing');
    assert.equal(d.minutes, 20);
    assert.equal(d.lastSeen, new Date(T0).toISOString());
    assert.equal(d.recovered, false);
});

test('not before the time is up, and the time is the owner\'s to set', () => {
    assert.equal(missingDecision({ settings: settings(), agent: agent({ lastSeenAt: new Date(now - 4 * MIN) }), now }), null);
    assert.ok(missingDecision({ settings: settings(), agent: agent({ lastSeenAt: new Date(now - 5 * MIN) }), now }));
    assert.equal(missingDecision({ settings: settings({ missing: { minutes: 30 } }), agent: agent(), now }), null);
});

test('it is said once, and never for an agent that has not been installed yet or has been turned off', () => {
    assert.equal(missingDecision({ settings: settings(), agent: agent({ alerts: { missing: { alerted: true } } }), now }), null);
    assert.equal(missingDecision({ settings: settings(), agent: { enabled: true }, now }), null, 'never heard from: not installed yet');
    assert.equal(missingDecision({ settings: settings(), agent: agent({ enabled: false }), now }), null);
    assert.equal(missingDecision({ settings: settings(), agent: undefined, now }), null);
    assert.equal(missingDecision({ settings: settings({ enabled: false }), agent: agent(), now }), null);
    assert.equal(missingDecision({ settings: settings(), agent: agent({ lastSeenAt: 'not a date' }), now }), null);
});

test('when the agent reports again after that, it says so, with how long it was quiet', () => {
    const state = markMissing({}, now, T0);
    assert.deepEqual(state.missing, { alerted: true, alertedAt: now, since: T0 });
    const r = evaluateSnapshots({ settings: settings(), state, points: [cpu(25, 10)], previousSeenAt: T0 });
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].type, 'host_metrics_missing');
    assert.equal(r.events[0].recovered, true);
    assert.equal(r.events[0].minutes, 25);
    assert.equal(r.state.missing.alerted, false);
});

test('that end waits when the owner cannot be told, and a silent agent keeps its other state', () => {
    const state = markMissing({ cpu: { since: null, alerted: false } }, now, T0);
    const r = evaluateSnapshots({ settings: settings(), state, points: [cpu(25, 10)], previousSeenAt: T0, canAlert: false });
    assert.deepEqual(r.events, []);
    assert.equal(r.state.missing.alerted, true);
    assert.ok(r.state.cpu);
});

// ── the event as it is kept, and in words ──

test('an event keeps only what is known about it, each part bounded', () => {
    const e = cleanHostAlert({
        metric: 'cpu', type: 'anything', recovered: true, value: 97.5, threshold: 90, minutes: 5, since: '2026-10-26T12:00:00Z',
        mount: `/${'m'.repeat(200)}`, procs: [{ name: 'a\nb', cpu: 5, mem: 2 }, { name: '', cpu: 1 }, { name: 'c', cpu: 'x' }, { name: 'd' }, { name: 'e' }], extra: 'ignored', alsoDown: true
    });
    assert.equal(e.type, 'host_cpu_high', 'the type follows the metric');
    assert.equal(e.recovered, true);
    assert.equal(e.mount.length, 64);
    assert.deepEqual(e.procs.map((p) => p.name), ['ab', 'c', 'd']);
    assert.equal(e.procs[1].cpu, 0);
    assert.equal('extra' in e, false);
    assert.equal(e.alsoDown, true);
    assert.equal(e.since, '2026-10-26T12:00:00.000Z');
});

test('anything that is not an event is nothing', () => {
    for (const odd of [null, undefined, 'x', 5, {}, { metric: 'gpu' }, { metric: '__proto__' }, []]) assert.equal(cleanHostAlert(odd), null, String(odd));
    assert.deepEqual(HOST_ALERT_TYPES, ['host_cpu_high', 'host_memory_high', 'host_disk_high', 'host_metrics_missing']);
    assert.equal(isHostAlert('host_cpu_high'), true);
    assert.equal(isHostAlert('server_down'), false);
});

test('each alert says what happened, with the numbers, and for a breach what to look at', () => {
    const say = (host, type) => hostAlertText({ type, host, serverName: 'Shop' });

    const cpuText = say({ metric: 'cpu', value: 97, threshold: 90, minutes: 5, procs: [{ name: 'node', cpu: 85, mem: 2 }] }, 'host_cpu_high');
    assert.equal(cpuText.title, 'CPU on Shop is high');
    assert.equal(cpuText.message, 'CPU has been above 90% for 5 minutes (now 97%).');
    assert.ok(cpuText.lines.some((l) => l.includes('What is using it: node 85% of one core')));
    assert.match(cpuText.subject, /WARNING: CPU on Shop is high/);
    assert.equal(cpuText.tone, 'warning');

    const memText = say({ metric: 'memory', value: 94, threshold: 90, minutes: 5, procs: [{ name: 'java', cpu: 1, mem: 61.25 }] }, 'host_memory_high');
    assert.ok(memText.lines.some((l) => l.includes('java 61.3% of memory') || l.includes('java 61.2% of memory')));

    const diskText = say({ metric: 'disk', value: 93, threshold: 90, minutes: 0, mount: '/data' }, 'host_disk_high');
    assert.equal(diskText.message, 'The disk /data has been above 90% full (now 93%).');
    assert.ok(diskText.lines.some((l) => /full disk makes databases and logs fail/.test(l)));
    assert.match(say({ metric: 'disk', value: 93, threshold: 90, minutes: 2, mount: '/' }, 'host_disk_high').message, /for 2 minutes/);

    const quiet = say({ metric: 'missing', minutes: 12, lastSeen: '2026-10-26T12:03:00Z', alsoDown: true }, 'host_metrics_missing');
    assert.equal(quiet.message, 'No data from the agent for 12 minutes (last heard 12:03 UTC).');
    assert.ok(quiet.lines.some((l) => l.includes('systemctl status pingpilot-agent')));
    assert.ok(quiet.lines.some((l) => l.includes('also see this server as down')));
    assert.ok(!say({ metric: 'missing', minutes: 12 }, 'host_metrics_missing').lines.some((l) => l.includes('also see')), 'only when it is true');
});

test('each end says it is back to normal, with how long it lasted', () => {
    const say = (host, type) => hostAlertText({ type, host, serverName: 'Shop' });
    const cpuEnd = say({ metric: 'cpu', recovered: true, value: 62, threshold: 90, lasted: 12 }, 'host_cpu_high');
    assert.equal(cpuEnd.message, 'CPU is back to 62% after 12 minutes above 90%.');
    assert.equal(cpuEnd.tone, 'ok');
    assert.match(cpuEnd.subject, /RESOLVED/);
    assert.equal(say({ metric: 'disk', recovered: true, value: 80, threshold: 90, mount: '/' }, 'host_disk_high').message, 'Disk / is back to 80% full.');
    assert.equal(say({ metric: 'missing', recovered: true, minutes: 14 }, 'host_metrics_missing').message, 'The agent is reporting again after 14 minutes.');
    assert.equal(say({ metric: 'missing', recovered: true, minutes: 1 }, 'host_metrics_missing').message, 'The agent is reporting again after 1 minute.');
});

test('text for something that is not that alert is nothing, and no message is longer than the feed allows', () => {
    assert.equal(hostAlertText({ type: 'host_cpu_high', host: { metric: 'disk', value: 1 }, serverName: 'x' }), null);
    assert.equal(hostAlertText({ type: 'server_down', host: { metric: 'cpu' }, serverName: 'x' }), null);
    assert.equal(hostAlertText({ type: 'host_cpu_high', host: null }), null);
    const long = hostAlertText({ type: 'host_disk_high', host: { metric: 'disk', value: 99, threshold: 90, minutes: 0, mount: 'm'.repeat(200) }, serverName: 'x' });
    assert.ok(long.message.length <= 300);
});
