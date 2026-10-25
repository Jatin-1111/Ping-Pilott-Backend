// Run with: npm test
// Slow alerts are judged over several scheduled checks, not one, and an open alert closes only after quick checks in a row.
// Before: a single slow sample alerted, the first quick sample closed the alert, and a site hovering around its limit
// alerted every time it crossed. "Check now" could also open or close a slow alert.

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAlert, planCheckUpdate, slowChecksNeeded, countsTowardSlowStreak, FAST_CHECKS_TO_CLOSE } from '../utils/alertDecision.js';
import { buildAlertMessage } from '../utils/alertFeed.js';

const SLOW = { status: 'up', responseTime: 2000, error: 'Slow response', slow: true };
const FAST = { status: 'up', responseTime: 120, error: null, slow: false };
const DOWN = { status: 'down', responseTime: null, error: 'Connection refused', slow: false };

// Feed a list of results through decideAlert the way the recorder would, saving the state between checks
const run = (results, { frequency = 5, checkType = 'automated', start = {} } = {}) => {
    let state = { slowAlerted: false, slowStreak: 0, fastStreak: 0, ...start };
    let status = 'up';
    const alerts = [];
    for (const result of results) {
        const decision = decideAlert(status, result, state, { frequency, checkType });
        alerts.push(decision.alertType);
        if (decision.touchStreak) state = { slowAlerted: decision.slowAlerted, slowStreak: decision.slowStreak, fastStreak: decision.fastStreak };
        status = result.status;
    }
    return { alerts, state };
};

test('how many slow checks it takes depends on how often the server is checked: 3, 2 or 1', () => {
    for (const f of [1, 2, 3, 5]) assert.equal(slowChecksNeeded(f), 3, `${f} min`);
    for (const f of [6, 10, 15]) assert.equal(slowChecksNeeded(f), 2, `${f} min`);
    for (const f of [16, 30, 60]) assert.equal(slowChecksNeeded(f), 1, `${f} min`);
    assert.equal(slowChecksNeeded(undefined), 3, 'a missing frequency is the 5 minute default');
});

test('one slow check does not alert; the third in a row does, once', () => {
    const { alerts } = run([SLOW, SLOW, SLOW, SLOW, SLOW]);
    assert.deepEqual(alerts, [null, null, 'slow_response', null, null]);
});

test('a site that oscillates around its limit never builds a streak, so it sends nothing', () => {
    const { alerts, state } = run([SLOW, FAST, SLOW, FAST, SLOW, FAST, SLOW, SLOW, FAST]);
    assert.deepEqual(alerts, Array(9).fill(null));
    assert.equal(state.slowAlerted, false);
});

test('a 10 minute monitor alerts on the second slow check, a 30 minute one on the first', () => {
    assert.deepEqual(run([SLOW, SLOW, SLOW], { frequency: 10 }).alerts, [null, 'slow_response', null]);
    assert.deepEqual(run([SLOW, SLOW], { frequency: 30 }).alerts, ['slow_response', null]);
});

test('an open slow alert closes after two quick checks in a row, not after one', () => {
    const open = run([SLOW, SLOW, SLOW]).state;
    assert.equal(open.slowAlerted, true);

    const afterOne = run([FAST], { start: open }).state;
    assert.equal(afterOne.slowAlerted, true, 'one quick check is not enough to close it');

    const afterTwo = run([FAST, FAST], { start: open }).state;
    assert.equal(afterTwo.slowAlerted, false);
    assert.equal(FAST_CHECKS_TO_CLOSE, 2);
});

test('a slow check between quick ones keeps the alert open, and does not send a second one', () => {
    const open = run([SLOW, SLOW, SLOW]).state;
    const { alerts, state } = run([FAST, SLOW, FAST, SLOW, SLOW, SLOW], { start: open });
    assert.deepEqual(alerts, Array(6).fill(null));
    assert.equal(state.slowAlerted, true);
});

test('once closed, the next slow streak alerts again', () => {
    const { alerts } = run([SLOW, SLOW, SLOW, FAST, FAST, SLOW, SLOW, SLOW]);
    assert.deepEqual(alerts, [null, null, 'slow_response', null, null, null, null, 'slow_response']);
});

test('going down ends the streak and the open slow alert; recovery starts counting again', () => {
    const open = run([SLOW, SLOW, SLOW]).state;
    const down = decideAlert('up', DOWN, open, { frequency: 5 });
    assert.equal(down.alertType, 'server_down');
    assert.deepEqual([down.slowAlerted, down.slowStreak, down.fastStreak], [false, 0, 0]);

    // back up, and slow: that check is the first sample of a new streak and alerts only as a recovery
    const back = decideAlert('down', SLOW, down, { frequency: 5 });
    assert.equal(back.alertType, 'server_recovery');
    assert.deepEqual([back.slowAlerted, back.slowStreak], [false, 1]);
});

test('the very first check of a server (unknown) never sends a slow alert or a recovery', () => {
    const first = decideAlert('unknown', SLOW, {}, { frequency: 5 });
    assert.equal(first.alertType, null);
    assert.equal(first.slowStreak, 1);
    assert.equal(decideAlert('unknown', DOWN, {}, { frequency: 5 }).alertType, 'server_down');
});

test('manual and batch checks never open, close or count toward a slow alert', () => {
    assert.equal(countsTowardSlowStreak('automated'), true);
    assert.equal(countsTowardSlowStreak(), true);
    assert.equal(countsTowardSlowStreak('manual'), false);
    assert.equal(countsTowardSlowStreak('batch'), false);

    // three manual checks in a row on a slow server: nothing, and the saved counters are left alone
    const twoSlow = run([SLOW, SLOW]).state;
    for (const checkType of ['manual', 'batch']) {
        const { alerts } = run([SLOW, SLOW, SLOW], { checkType, start: twoSlow });
        assert.deepEqual(alerts, [null, null, null]);
    }
    const decision = decideAlert('up', SLOW, twoSlow, { frequency: 5, checkType: 'manual' });
    assert.equal(decision.touchStreak, false);

    // and they cannot close an open alert either
    const open = run([SLOW, SLOW, SLOW]).state;
    assert.equal(run([FAST, FAST, FAST], { checkType: 'manual', start: open }).state.slowAlerted, true);
});

test('a manual check that changes the status still alerts, and restarts the counters', () => {
    const open = run([SLOW, SLOW, SLOW]).state;
    const down = decideAlert('up', DOWN, open, { frequency: 5, checkType: 'manual' });
    assert.equal(down.alertType, 'server_down');
    assert.equal(down.touchStreak, true);
    assert.deepEqual([down.slowAlerted, down.slowStreak, down.fastStreak], [false, 0, 0]);

    // a manual "up" after an outage is a recovery but not a sample of the slow streak
    const back = decideAlert('down', SLOW, down, { frequency: 5, checkType: 'manual' });
    assert.equal(back.alertType, 'server_recovery');
    assert.deepEqual([back.slowStreak, back.fastStreak], [0, 0]);
});

test('missing or junk counters on an old server row count as zero', () => {
    const decision = decideAlert('up', SLOW, { slowStreak: undefined, fastStreak: 'x', slowAlerted: undefined }, { frequency: 5 });
    assert.deepEqual([decision.alertType, decision.slowStreak, decision.fastStreak, decision.slowAlerted], [null, 1, 0, false]);
});

// ── planCheckUpdate: what is written ──

const NOW = new Date('2026-10-25T10:00:00Z');
const serverDoc = (extra = {}) => ({ _id: 's1', status: 'up', monitoring: { frequency: 5 }, ...extra });

test('a scheduled slow check writes the counters, and the alert that opens it is guarded by compare-and-set', () => {
    const plan = planCheckUpdate({ server: serverDoc({ slowStreak: 2 }), checkResult: SLOW, checkType: 'automated', now: NOW });
    assert.equal(plan.alertType, 'slow_response');
    assert.equal(plan.slowStreak, 3);
    assert.deepEqual(plan.$set, {
        status: 'up', responseTime: 2000, error: 'Slow response', failureKind: null, lastChecked: NOW,
        slowAlerted: true, slowStreak: 3, fastStreak: 0
    });
    assert.deepEqual(plan.filter, { _id: 's1', slowAlerted: { $ne: true } }, 'two racing checks cannot both open the alert');
});

test('a slow check that is not the alerting one has no compare-and-set filter', () => {
    const plan = planCheckUpdate({ server: serverDoc({ slowStreak: 0 }), checkResult: SLOW, now: NOW });
    assert.equal(plan.alertType, null);
    assert.deepEqual(plan.filter, { _id: 's1' });
    assert.equal(plan.$set.slowStreak, 1);
});

test('a manual check on an unchanged status leaves the saved counters out of the write entirely', () => {
    // even if the caller did not load them: writing zeros would erase a streak the scheduler has built
    const plan = planCheckUpdate({ server: serverDoc(), checkResult: SLOW, checkType: 'manual', now: NOW });
    assert.equal(plan.alertType, null);
    for (const field of ['slowAlerted', 'slowStreak', 'fastStreak']) assert.equal(field in plan.$set, false, field);
    assert.equal(plan.$set.responseTime, 2000, 'the latest response time is still shown');
});

test('a status change writes the new status, the change time, and is guarded by the old status', () => {
    const plan = planCheckUpdate({ server: serverDoc({ slowAlerted: true, slowStreak: 5 }), checkResult: DOWN, now: NOW });
    assert.equal(plan.alertType, 'server_down');
    assert.equal(plan.changed, true);
    assert.equal(plan.$set.lastStatusChange, NOW);
    assert.deepEqual([plan.$set.slowAlerted, plan.$set.slowStreak, plan.$set.fastStreak], [false, 0, 0]);
    assert.deepEqual(plan.filter, { _id: 's1', status: 'up' });
});

test('the alert wording says how many checks in a row, and keeps the old wording without a streak', () => {
    const server = { monitoring: { alerts: { responseThreshold: 1000 } } };
    assert.equal(
        buildAlertMessage('slow_response', { responseTime: 2310, slowStreak: 3 }, server),
        'Slower than your 1000 ms limit for 3 checks in a row, latest 2310 ms.'
    );
    assert.equal(
        buildAlertMessage('slow_response', { responseTime: 2310 }, server),
        'Responded in 2310 ms, above your 1000 ms limit.'
    );
});
