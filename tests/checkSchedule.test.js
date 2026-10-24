// Run with: npm test
// Regression for: with SMART_MONITORING_ENABLED unset the scheduler woke up every 3 minutes, so a paid user's
// 1-minute and 2-minute monitors were checked every 3 minutes. The scheduler now wakes up every minute, always.

import test from 'node:test';
import assert from 'node:assert/strict';
import cron from 'node-cron';
import { CHECK_CRON, TICK_MS, tickOf, nextCheckSlot } from '../utils/checkSchedule.js';

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
