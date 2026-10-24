// Run with: npm test
// The scheduler must never get stuck, and history must survive the midnight cleanup by default.
// No database or Redis: jobs are plain functions, and a "hung Redis call" is a promise that never settles.

import test from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue } from '../utils/jobQueue.js';
import { withTimeout, TimeoutError } from '../utils/timeout.js';
import { resolveRetentionMode, retentionJobName, DEFAULT_RETENTION_MODE } from '../utils/retentionMode.js';
import { evaluateScheduler, startSchedulerWatchdog, MAX_SILENCE_MS } from '../tasks/schedulerWatchdog.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise(() => {});
const deferred = () => {
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
};

// ---- withTimeout --------------------------------------------------------------------------------------------

test('withTimeout passes through a result that arrives in time', async () => {
    assert.equal(await withTimeout(Promise.resolve('ok'), 100, 'x'), 'ok');
});

test('withTimeout rejects a promise that never settles, naming what timed out', async () => {
    await assert.rejects(withTimeout(never(), 20, 'Queueing a check'), (err) => {
        assert.ok(err instanceof TimeoutError);
        assert.match(err.message, /Queueing a check timed out after 20ms/);
        return true;
    });
});

test('withTimeout keeps a real failure as that failure', async () => {
    await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 100), /boom/);
});

test('a promise that fails after its timeout leaves nothing unhandled', async () => {
    const unhandled = [];
    const listener = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
        const late = new Promise((_, reject) => setTimeout(() => reject(new Error('late failure')), 40));
        await assert.rejects(withTimeout(late, 10), TimeoutError);
        await sleep(80);
        assert.deepEqual(unhandled, []);
    } finally {
        process.off('unhandledRejection', listener);
    }
});

// ---- JobQueue -----------------------------------------------------------------------------------------------

test('a job runs, returns its result and records when it last finished', async () => {
    const queue = new JobQueue();
    queue.add('job', async () => ({ dispatched: 3 }));

    assert.equal(queue.lastRunOf('job'), null);
    assert.deepEqual(await queue.execute('job'), { dispatched: 3 });
    assert.ok(queue.lastRunOf('job') instanceof Date);
    assert.equal(queue.isRunning('job'), false);
});

test('a job already running is skipped, not run twice', async () => {
    const queue = new JobQueue();
    const gate = deferred();
    queue.add('job', () => gate.promise);

    const first = queue.execute('job');
    assert.equal(queue.isRunning('job'), true);
    assert.equal(await queue.execute('job'), false);

    gate.resolve('done');
    assert.equal(await first, 'done');
    assert.equal(queue.isRunning('job'), false);
});

test('a job that never finishes is given up on, and the next run goes ahead', async () => {
    const queue = new JobQueue();
    let calls = 0;
    queue.add('job', () => (++calls === 1 ? never() : Promise.resolve('second run')), 1, { timeoutMs: 30 });

    await assert.rejects(queue.execute('job'), TimeoutError);
    assert.equal(queue.isRunning('job'), false, 'the lock was released');
    assert.equal(await queue.execute('job'), 'second run', 'the next cycle is not skipped');
    assert.equal(calls, 2);
});

test('a job added without a timeout keeps the old behaviour: a hung run blocks the later ones', async () => {
    const queue = new JobQueue();
    queue.add('job', never); // no timeout given

    queue.execute('job'); // hangs
    assert.equal(await queue.execute('job'), false);
    assert.equal(await queue.execute('job'), false);
});

test('a failing job reports the error and still releases its lock', async () => {
    const queue = new JobQueue();
    let calls = 0;
    queue.add('job', async () => {
        if (++calls === 1) throw new Error('database down');
        return 'recovered';
    });

    await assert.rejects(queue.execute('job'), /database down/);
    assert.equal(queue.isRunning('job'), false);
    assert.equal(await queue.execute('job'), 'recovered');
    assert.equal(queue.lastRunOf('job') !== null, true);
});

test('forceRelease unblocks a stuck job, and the old run cannot release the new run\'s lock when it finally ends', async () => {
    const queue = new JobQueue();
    const gates = [deferred(), deferred()];
    let calls = 0;
    queue.add('job', () => gates[calls++].promise);

    const stuck = queue.execute('job');
    assert.equal(queue.forceRelease('job'), true);
    assert.equal(queue.isRunning('job'), false);

    const replacement = queue.execute('job');
    assert.equal(queue.isRunning('job'), true);

    gates[0].resolve('old run finishes late');
    await stuck;
    assert.equal(queue.isRunning('job'), true, 'the replacement still holds the lock');

    gates[1].resolve('new run');
    assert.equal(await replacement, 'new run');
    assert.equal(queue.isRunning('job'), false);
});

test('forceRelease on a job that is not running does nothing', () => {
    const queue = new JobQueue();
    queue.add('job', async () => 1);
    assert.equal(queue.forceRelease('job'), false);
});

test('runningForMs says how long the current run has been going', async () => {
    const queue = new JobQueue();
    queue.add('job', never);
    queue.execute('job');
    const now = Date.now();

    assert.equal(queue.runningForMs('job', now) >= 0, true);
    assert.equal(queue.runningForMs('job', now + 5000) >= 5000, true);
    assert.equal(queue.runningForMs('other'), null);
});

test('a stopped queue or an unknown job runs nothing', async () => {
    const queue = new JobQueue();
    queue.add('job', async () => 1);

    assert.equal(await queue.execute('missing'), false);
    queue.stop();
    assert.equal(await queue.execute('job'), false);
    queue.start();
    assert.equal(await queue.execute('job'), 1);
});

// ---- retention default --------------------------------------------------------------------------------------

test('with nothing set, the cleanup keeps history (selective)', () => {
    assert.equal(DEFAULT_RETENTION_MODE, 'selective');
    for (const unset of [undefined, null, '', '   ']) {
        assert.deepEqual(resolveRetentionMode(unset), { mode: 'selective', recognized: true });
    }
    assert.equal(retentionJobName(resolveRetentionMode(undefined).mode), 'selectiveDataRetention');
});

test('the three modes can still be chosen on purpose, in any case', () => {
    assert.equal(resolveRetentionMode('aggressive').mode, 'aggressive');
    assert.equal(resolveRetentionMode(' Emergency ').mode, 'emergency');
    assert.equal(resolveRetentionMode('SELECTIVE').mode, 'selective');
    assert.equal(retentionJobName('aggressive'), 'aggressiveDataRetention');
    assert.equal(retentionJobName('emergency'), 'emergencyCleanup');
});

test('a typo falls back to the safe mode and is flagged, never to one that deletes everything', () => {
    assert.deepEqual(resolveRetentionMode('agressive'), { mode: 'selective', recognized: false });
    assert.equal(retentionJobName('nonsense'), 'selectiveDataRetention');
});

// ---- watchdog -----------------------------------------------------------------------------------------------

const MIN = 60_000;

test('a scheduler that finished a cycle recently is fine', () => {
    const now = 1_000_000_000;
    assert.equal(evaluateScheduler({ lastRun: new Date(now - 2 * MIN), startedAt: now - 60 * MIN, now }), 'ok');
});

test('a scheduler that has been silent too long is stalled', () => {
    const now = 1_000_000_000;
    assert.equal(evaluateScheduler({ lastRun: new Date(now - 11 * MIN), startedAt: now - 60 * MIN, now }), 'stalled');
    assert.equal(MAX_SILENCE_MS, 10 * MIN);
});

test('right after startup there is a grace period before the first cycle', () => {
    const now = 1_000_000_000;
    assert.equal(evaluateScheduler({ lastRun: null, startedAt: now - 2 * MIN, now }), 'ok');
    assert.equal(evaluateScheduler({ lastRun: null, startedAt: now - 12 * MIN, now }), 'stalled');
});

const fakeQueue = ({ lastRun, running }) => {
    const calls = { released: [] };
    return {
        calls,
        lastRunOf: () => lastRun,
        forceRelease: (name) => {
            calls.released.push(name);
            return running;
        },
    };
};

test('when stalled, the watchdog releases a stuck lock', () => {
    const now = Date.now();
    const queue = fakeQueue({ lastRun: new Date(now - 30 * MIN), running: true });
    const watchdog = startSchedulerWatchdog({ queue, startedAt: now - 60 * MIN, intervalMs: 3_600_000 });
    try {
        assert.equal(watchdog.check(now), 'stalled');
        assert.deepEqual(queue.calls.released, ['smartCheckServers']);
    } finally {
        watchdog.stop();
    }
});

test('when healthy, the watchdog leaves the lock alone', () => {
    const now = Date.now();
    const queue = fakeQueue({ lastRun: new Date(now - 1 * MIN), running: true });
    const watchdog = startSchedulerWatchdog({ queue, startedAt: now - 60 * MIN, intervalMs: 3_600_000 });
    try {
        assert.equal(watchdog.check(now), 'ok');
        assert.equal(watchdog.status(now), 'ok');
        assert.deepEqual(queue.calls.released, []);
    } finally {
        watchdog.stop();
    }
});
