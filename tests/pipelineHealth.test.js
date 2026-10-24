// Run with: npm test
// Regression for F2: /health was green while no server was being checked (dead workers), the stall watchdog reported
// "ok" while the database or Redis was down (a failed cycle returned instead of throwing), and nothing outside the
// process noticed any of it.
// No Redis or database: Redis is a fake with set, del, get and scan.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { dispatchCycle } from '../tasks/dispatchCycle.js';
import { evaluatePipeline, getPipelineHealth, recordDispatch, recentDispatches, resetDispatches, resetPipelineCache, NO_COMPLETION_MS, STARTUP_GRACE_MS } from '../services/pipelineHealth.js';
import { startWorkerHeartbeat, createCheckCompletionRecorder, readWorkerState } from '../utils/workerHealth.js';
import { beatKey, beatPattern, LAST_CHECK_KEY } from '../utils/healthKeys.js';
import { startHeartbeat } from '../tasks/heartbeat.js';
import { evaluateScheduler } from '../tasks/schedulerWatchdog.js';
import { JobQueue } from '../utils/jobQueue.js';

const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const LONG_RUNNING = NOW - 60 * MIN; // started long ago: no startup grace

const healthy = { now: NOW, startedAt: LONG_RUNNING, schedulerStatus: 'ok', monitorWorkers: 1, alertWorkers: 1, lastCheckCompletedAt: NOW - 20 * 1000, dispatches: [NOW - 30 * 1000] };

// --- the scheduler cycle must fail loudly ---

test('a cycle with nothing due is a success', async () => {
    const result = await dispatchCycle({ tick: new Date(), findDue: async () => [], addJob: async () => true, bookNext: async () => {} });
    assert.deepEqual(result, { total: 0, dispatched: 0 });
});

test('a cycle that queues everything books the next slots and reports it', async () => {
    const booked = [];
    const result = await dispatchCycle({ tick: new Date(), findDue: async () => [{ _id: 1 }, { _id: 2 }], addJob: async () => true, bookNext: async (s) => booked.push(...s) });
    assert.deepEqual(result, { total: 2, dispatched: 2 });
    assert.equal(booked.length, 2);
});

test('some jobs failing to queue is a bad minute, not a failed cycle, and only queued servers are booked', async () => {
    const booked = [];
    const result = await dispatchCycle({
        tick: new Date(),
        findDue: async () => [{ _id: 1 }, { _id: 2 }, { _id: 3 }],
        addJob: async (s) => s._id !== 2,
        bookNext: async (s) => booked.push(...s.map((x) => x._id)),
    });
    assert.deepEqual(result, { total: 3, dispatched: 2 });
    assert.deepEqual(booked.sort(), [1, 3]);
});

test('a cycle that could not queue anything throws, so it does not count as a finished cycle', async () => {
    await assert.rejects(
        dispatchCycle({ tick: new Date(), findDue: async () => [{ _id: 1 }, { _id: 2 }], addJob: async () => false, bookNext: async () => {} }),
        /Could not queue any of the 2 due checks/
    );
});

test('a database failure while reading the due servers throws too', async () => {
    await assert.rejects(
        dispatchCycle({ tick: new Date(), findDue: async () => { throw new Error('database down'); }, addJob: async () => true, bookNext: async () => {} }),
        /database down/
    );
});

test('a failed cycle leaves lastRun alone, so the watchdog sees the scheduler as stalled instead of ok', async () => {
    const queue = new JobQueue();
    queue.add('cycle', async () => { throw new Error('Redis down'); });
    await assert.rejects(queue.execute('cycle'), /Redis down/);
    assert.equal(queue.lastRunOf('cycle'), null);
    assert.equal(evaluateScheduler({ lastRun: queue.lastRunOf('cycle'), startedAt: NOW - 11 * MIN, now: NOW }), 'stalled');
});

// --- the rule ---

test('workers alive, checks finishing: ok', () => {
    assert.deepEqual(evaluatePipeline(healthy), { state: 'ok', reasons: [] });
});

test('a stalled scheduler is degraded, even right after a restart', () => {
    const result = evaluatePipeline({ ...healthy, schedulerStatus: 'stalled', startedAt: NOW - 30 * 1000 });
    assert.equal(result.state, 'degraded');
    assert.deepEqual(result.reasons, ['scheduler-stalled']);
});

test('no monitor worker heartbeat is degraded, and so is no alert worker', () => {
    assert.deepEqual(evaluatePipeline({ ...healthy, monitorWorkers: 0 }).reasons, ['no-monitor-worker']);
    assert.deepEqual(evaluatePipeline({ ...healthy, alertWorkers: 0 }).reasons, ['no-alert-worker']);
    assert.equal(evaluatePipeline({ ...healthy, monitorWorkers: 0 }).state, 'degraded');
});

test('right after a restart a missing worker is "starting", not degraded', () => {
    const result = evaluatePipeline({ ...healthy, monitorWorkers: 0, startedAt: NOW - (STARTUP_GRACE_MS - 1000) });
    assert.equal(result.state, 'starting');
    assert.equal(evaluatePipeline({ ...healthy, monitorWorkers: 0, startedAt: NOW - (STARTUP_GRACE_MS + 1000) }).state, 'degraded');
});

test('checks queued more than 5 minutes ago with nothing finished since is degraded: workers alive but not doing the work', () => {
    const result = evaluatePipeline({ ...healthy, lastCheckCompletedAt: NOW - 8 * MIN, dispatches: [NOW - 6 * MIN, NOW - 3 * MIN, NOW - 1 * MIN] });
    assert.equal(result.state, 'degraded');
    assert.deepEqual(result.reasons, ['checks-not-completing']);
});

test('the same dispatches are fine once a check finished after them', () => {
    const result = evaluatePipeline({ ...healthy, lastCheckCompletedAt: NOW - 20 * 1000, dispatches: [NOW - 6 * MIN, NOW - 3 * MIN] });
    assert.equal(result.state, 'ok');
});

test('a monitor that is checked once an hour does not look stuck between checks', () => {
    // queued 7 minutes ago, finished 3 seconds later
    const queuedAt = NOW - 7 * MIN;
    const result = evaluatePipeline({ ...healthy, lastCheckCompletedAt: queuedAt + 3000, dispatches: [queuedAt] });
    assert.equal(result.state, 'ok');
});

test('nothing due and nothing finished is fine: an account with no servers is not an outage', () => {
    assert.equal(evaluatePipeline({ ...healthy, lastCheckCompletedAt: null, dispatches: [] }).state, 'ok');
});

test('checks queued less than 5 minutes ago and not finished yet are not a problem', () => {
    const result = evaluatePipeline({ ...healthy, lastCheckCompletedAt: NOW - 20 * MIN, dispatches: [NOW - (NO_COMPLETION_MS - 1000)] });
    assert.equal(result.state, 'ok');
});

test('when Redis cannot be read the state is cannot-read-state, not a guess', () => {
    const result = evaluatePipeline({ ...healthy, monitorWorkers: null, alertWorkers: null });
    assert.equal(result.state, 'degraded');
    assert.deepEqual(result.reasons, ['cannot-read-state']);
});

// --- worker heartbeats ---

const fakeRedis = (store = new Map(), { failSet = false } = {}) => ({
    store,
    sets: [],
    async set(key, value, ...rest) { if (failSet) throw new Error('Redis down'); this.sets.push({ key, value, rest }); store.set(key, value); return 'OK'; },
    async del(key) { store.delete(key); return 1; },
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async scan(cursor, _match, pattern) {
        const prefix = pattern.replace(/\*$/, '');
        return ['0', [...store.keys()].filter((k) => k.startsWith(prefix))];
    },
});

test('a worker writes its heartbeat with an expiry, and removes it on a clean stop', async () => {
    const redis = fakeRedis();
    const beat = startWorkerHeartbeat({ redis, role: 'monitor', intervalMs: 60_000, id: 'host1:42' });
    await beat.beat();
    assert.equal(beat.key, 'pp:health:monitor-worker:host1:42');
    assert.ok(redis.store.has(beat.key));
    assert.deepEqual(redis.sets[0].rest, ['EX', 60]);
    await beat.stop();
    assert.equal(redis.store.has(beat.key), false);
});

test('a worker that is not running writes no heartbeat, so its key expires', async () => {
    const redis = fakeRedis();
    const beat = startWorkerHeartbeat({ redis, role: 'alert', isRunning: () => false, intervalMs: 60_000, id: 'host1:43' });
    await beat.beat();
    assert.equal(redis.sets.length, 0);
    await beat.stop();
});

test('a heartbeat that cannot be written does not throw', async () => {
    const redis = fakeRedis(new Map(), { failSet: true });
    const beat = startWorkerHeartbeat({ redis, role: 'monitor', intervalMs: 60_000, id: 'host1:44' });
    await assert.doesNotReject(beat.beat());
    await beat.stop();
});

test('the completion marker is written at most once per gap', async () => {
    const redis = fakeRedis();
    let clock = 1_000_000;
    const mark = createCheckCompletionRecorder({ redis, minGapMs: 5000, now: () => clock });
    mark(); mark(); mark();
    clock += 4000; mark();
    clock += 2000; mark();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(redis.sets.filter((s) => s.key === LAST_CHECK_KEY).length, 2);
});

test('readWorkerState counts live workers by role and reads the last completed check', async () => {
    const redis = fakeRedis(new Map([
        [beatKey('monitor', 'a:1'), '1'], [beatKey('monitor', 'b:2'), '1'], [beatKey('alert', 'a:3'), '1'], [LAST_CHECK_KEY, '1700000000000'],
    ]));
    assert.deepEqual(await readWorkerState(redis), { monitorWorkers: 2, alertWorkers: 1, lastCheckCompletedAt: 1700000000000 });
    assert.deepEqual(await readWorkerState(fakeRedis()), { monitorWorkers: 0, alertWorkers: 0, lastCheckCompletedAt: null });
});

test('a container looks for its own host only', () => {
    assert.equal(beatPattern('monitor'), 'pp:health:monitor-worker:*');
    assert.equal(beatPattern('alert', 'abc123'), 'pp:health:alert-worker:abc123:*');
    assert.ok(beatKey('monitor').startsWith(`pp:health:monitor-worker:${os.hostname()}:`));
});

test('getPipelineHealth reads the workers, uses this process\'s dispatches, and is cached for a few seconds', async () => {
    resetDispatches(); resetPipelineCache();
    const redis = fakeRedis(new Map([[beatKey('monitor', 'a:1'), '1'], [beatKey('alert', 'a:2'), '1'], [LAST_CHECK_KEY, String(NOW - 10 * 1000)]]));
    recordDispatch(NOW - 20 * 1000);
    assert.equal(recentDispatches(NOW).length, 1);

    const first = await getPipelineHealth({ redis, schedulerStatus: 'ok', startedAt: LONG_RUNNING, now: NOW });
    assert.equal(first.state, 'ok');

    redis.store.clear(); // the workers die, but the answer is cached for 5 s
    assert.equal((await getPipelineHealth({ redis, schedulerStatus: 'ok', startedAt: LONG_RUNNING, now: NOW + 2000 })).state, 'ok');
    const later = await getPipelineHealth({ redis, schedulerStatus: 'ok', startedAt: LONG_RUNNING, now: NOW + 6000 });
    assert.equal(later.state, 'degraded');
    assert.ok(later.reasons.includes('no-monitor-worker'));
    resetDispatches(); resetPipelineCache();
});

test('an unreadable Redis gives cannot-read-state', async () => {
    resetPipelineCache();
    const broken = { async scan() { throw new Error('Redis down'); }, async get() { throw new Error('Redis down'); } };
    const result = await getPipelineHealth({ redis: broken, schedulerStatus: 'ok', startedAt: LONG_RUNNING, now: NOW });
    assert.deepEqual(result.reasons, ['cannot-read-state']);
    resetPipelineCache();
});

// --- outside heartbeat ---

test('without HEARTBEAT_URL nothing is started', () => {
    assert.equal(startHeartbeat({ url: '', isHealthy: async () => true }), null);
    assert.equal(startHeartbeat({ url: undefined, isHealthy: async () => true }), null);
});

test('the heartbeat is sent while monitoring is healthy and withheld when it is not', async () => {
    const pings = [];
    let ok = true;
    const hb = startHeartbeat({ url: 'https://hc.example.com/ping/abc', isHealthy: async () => ok, ping: async (u) => { pings.push(u); }, intervalMs: 3_600_000 });
    assert.equal(await hb.tick(), true);
    ok = false;
    assert.equal(await hb.tick(), false);
    assert.equal(pings.length, 1, 'no ping while degraded: the outside service raises the alarm');
    hb.stop();
});

test('a ping that fails, or a health check that throws, never throws', async () => {
    const hb = startHeartbeat({ url: 'https://hc.example.com/ping/abc', isHealthy: async () => true, ping: async () => { throw new Error('ENOTFOUND'); }, intervalMs: 3_600_000 });
    assert.equal(await hb.tick(), false);
    hb.stop();
    const hb2 = startHeartbeat({ url: 'https://hc.example.com/ping/abc', isHealthy: async () => { throw new Error('boom'); }, ping: async () => {}, intervalMs: 3_600_000 });
    assert.equal(await hb2.tick(), false);
    hb2.stop();
});
