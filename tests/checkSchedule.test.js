// Run with: npm test
// Regression for: with SMART_MONITORING_ENABLED unset the scheduler woke up every 3 minutes, so a paid user's
// 1-minute and 2-minute monitors were checked every 3 minutes. The scheduler now wakes up every minute, always.

import test from 'node:test';
import assert from 'node:assert/strict';
import cron from 'node-cron';
import mongoose from 'mongoose';
import { CHECK_CRON, TICK_MS, tickOf, nextCheckSlot, checkOffsetMs, checkJobOptions } from '../utils/checkSchedule.js';

// The scheduler's rule: a server is dispatched on a tick when its nextCheckAt is null or at or before that tick
const isDue = (nextCheckAt, tick) => nextCheckAt === null || nextCheckAt.getTime() <= tick.getTime();

test('the scheduler cron is valid and fires every minute, whatever the environment says', () => {
    assert.equal(cron.validate(CHECK_CRON), true);
    assert.equal(CHECK_CRON, '* * * * *');
});

test('a tick is the start of the current minute', () => {
    const tick = tickOf(Date.UTC(2026, 9, 24, 10, 30, 47, 123));
    assert.equal(tick.toISOString(), '2026-10-24T10:30:00.000Z');
});

test('a 1-minute monitor is due on every consecutive tick', () => {
    let tick = tickOf(Date.UTC(2026, 9, 24, 10, 0, 5));
    let nextCheckAt = null;
    for (let i = 0; i < 10; i += 1) {
        assert.equal(isDue(nextCheckAt, tick), true, `due at tick ${i}`);
        nextCheckAt = nextCheckSlot(tick, 1);
        tick = new Date(tick.getTime() + TICK_MS);
    }
});

test('a 2-minute monitor is due every second tick, and a 5-minute one every fifth', () => {
    const countDue = (frequency) => {
        let tick = tickOf(Date.UTC(2026, 9, 24, 10, 0, 5));
        let nextCheckAt = null;
        let due = 0;
        for (let i = 0; i < 20; i += 1) {
            if (isDue(nextCheckAt, tick)) {
                due += 1;
                nextCheckAt = nextCheckSlot(tick, frequency);
            }
            tick = new Date(tick.getTime() + TICK_MS);
        }
        return due;
    };
    assert.equal(countDue(2), 10);
    assert.equal(countDue(5), 4);
});

test('a missing frequency counts as 5 minutes', () => {
    const tick = tickOf(Date.UTC(2026, 9, 24, 10, 0, 0));
    assert.equal(nextCheckSlot(tick, undefined).getTime() - tick.getTime(), 5 * TICK_MS);
});

// ── Spreading one tick's checks over the minute ──

const checked = (id, extra = {}) => ({ _id: id, lastChecked: new Date('2026-10-24T09:00:00Z'), ...extra });

test('a server always starts at the same offset into its tick, inside the minute', () => {
    const id = new mongoose.Types.ObjectId();
    const first = checkOffsetMs(checked(id));
    assert.equal(checkOffsetMs(checked(String(id))), first, 'an ObjectId and its string give the same offset');
    for (let i = 0; i < 5; i += 1) assert.equal(checkOffsetMs(checked(id)), first);
    assert.ok(Number.isInteger(first) && first >= 0 && first < TICK_MS);
});

test('ids made one after another are spread evenly over the minute, not bunched', () => {
    // Real ObjectIds from one process in a tight loop: the worst case, they differ only in a counter at the end
    const N = 10000;
    const BUCKETS = 10;
    const buckets = new Array(BUCKETS).fill(0);
    for (let i = 0; i < N; i += 1) {
        const offset = checkOffsetMs(checked(new mongoose.Types.ObjectId()));
        assert.ok(offset >= 0 && offset < TICK_MS);
        buckets[Math.floor(offset / (TICK_MS / BUCKETS))] += 1;
    }
    const mean = N / BUCKETS;
    for (const [i, count] of buckets.entries()) {
        assert.ok(count > mean * 0.75 && count < mean * 1.25, `bucket ${i} (${i * 6}s-${(i + 1) * 6}s) has ${count}, expected about ${mean}`);
    }
});

test('a server that has never been checked starts at once, so a new monitor shows a result without waiting', () => {
    const id = new mongoose.Types.ObjectId();
    assert.equal(checkOffsetMs({ _id: id, lastChecked: null }), 0);
    assert.equal(checkOffsetMs({ _id: id }), 0);
    assert.ok(checkOffsetMs(checked(id)) >= 0);
});

test('a server without an id, or a different window, is handled', () => {
    assert.equal(checkOffsetMs({ lastChecked: new Date() }), 0);
    assert.equal(checkOffsetMs(null), 0);
    const id = new mongoose.Types.ObjectId();
    assert.ok(checkOffsetMs(checked(id), 1000) < 1000);
});

test('the job options carry the offset as a delay, and leave the job id and priority as they were', () => {
    const tick = tickOf(Date.UTC(2026, 9, 24, 10, 30, 0));
    const id = new mongoose.Types.ObjectId();
    const options = checkJobOptions(checked(id), tick);

    assert.equal(options.jobId, `check-${id}-${tick.getTime()}`, 'same id format, so a tick is still never queued twice');
    assert.equal(options.priority, 2);
    assert.equal(options.delay, checkOffsetMs(checked(id)));
    assert.ok(options.delay < TICK_MS, 'always inside its own minute, far from the 10 minute stale limit');

    // next tick: a different job id, the same delay
    const later = checkJobOptions(checked(id), new Date(tick.getTime() + TICK_MS));
    assert.notEqual(later.jobId, options.jobId);
    assert.equal(later.delay, options.delay);
});

test('priority maps high, normal and low to 1, 2 and 3, and a never-checked server has no delay key at all', () => {
    const tick = tickOf(Date.UTC(2026, 9, 24, 10, 0, 0));
    const id = new mongoose.Types.ObjectId();
    assert.equal(checkJobOptions(checked(id, { priority: 'high' }), tick).priority, 1);
    assert.equal(checkJobOptions(checked(id, { priority: 'normal' }), tick).priority, 2);
    assert.equal(checkJobOptions(checked(id), tick).priority, 2);
    assert.equal(checkJobOptions(checked(id, { priority: 'low' }), tick).priority, 3);

    const fresh = checkJobOptions({ _id: id, lastChecked: null }, tick);
    assert.equal('delay' in fresh, false);
});

test('the check times of one server stay exactly one frequency apart, which random jitter would not', () => {
    const id = new mongoose.Types.ObjectId();
    const server = checked(id);
    let tick = tickOf(Date.UTC(2026, 9, 24, 10, 0, 5));
    const starts = [];
    for (let i = 0; i < 6; i += 1) {
        starts.push(tick.getTime() + checkOffsetMs(server));
        tick = nextCheckSlot(tick, 5);
    }
    for (let i = 1; i < starts.length; i += 1) assert.equal(starts[i] - starts[i - 1], 5 * TICK_MS);
});
