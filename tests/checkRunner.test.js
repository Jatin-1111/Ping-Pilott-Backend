// Run with: npm test
// Regression for F7: "Check now" and the batch check acted on the first failure at once (a DOWN email for one dropped
// packet), a brand-new server's first failure did the same, and manual checks counted in the uptime figure.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runCheck, confirmDelayMs, SCHEDULED_CHECKS_ONLY } from '../services/checkRunner.js';

const UP = { status: 'up', responseTime: 120, error: null, slow: false };
const DOWN = { status: 'down', responseTime: null, error: 'Connection refused', slow: false };

// A checker that answers from a list and counts the calls; sleep records how long it was asked to wait
const harness = (...answers) => {
    const waits = [];
    let calls = 0;
    return {
        waits,
        get calls() { return calls; },
        options: {
            check: async () => answers[Math.min(calls++, answers.length - 1)],
            sleep: async (ms) => { waits.push(ms); },
            delayMs: 10000,
        },
    };
};

test('an up result is returned as it is, with no second check', async () => {
    const h = harness(UP);
    assert.deepEqual(await runCheck({ status: 'up' }, h.options), UP);
    assert.equal(h.calls, 1);
});

test('a first failure on an up server is checked again after the delay, and the second answer wins', async () => {
    const recovered = harness(DOWN, UP);
    assert.equal((await runCheck({ status: 'up' }, recovered.options)).status, 'up', 'one dropped request is not an outage');
    assert.equal(recovered.calls, 2);
    assert.deepEqual(recovered.waits, [10000]);

    const stillDown = harness(DOWN, DOWN);
    assert.equal((await runCheck({ status: 'up' }, stillDown.options)).status, 'down');
    assert.equal(stillDown.calls, 2);
});

test('a first failure on a server that was never checked is confirmed too', async () => {
    const h = harness(DOWN, UP);
    assert.equal((await runCheck({ status: 'unknown' }, h.options)).status, 'up');
    assert.equal(h.calls, 2);
});

test('a server that is already down is not re-checked: it stays down, no wait', async () => {
    const h = harness(DOWN);
    assert.equal((await runCheck({ status: 'down' }, h.options)).status, 'down');
    assert.equal(h.calls, 1);
    assert.deepEqual(h.waits, []);
});

test('a delay of 0 switches confirmation off', async () => {
    const h = harness(DOWN, UP);
    const result = await runCheck({ status: 'up' }, { ...h.options, delayMs: 0 });
    assert.equal(result.status, 'down');
    assert.equal(h.calls, 1);
});

test('DOWN_CONFIRM_DELAY_MS: unset is 10 s, a number is used, 0 disables, nonsense falls back', () => {
    assert.equal(confirmDelayMs({}), 10000);
    assert.equal(confirmDelayMs({ DOWN_CONFIRM_DELAY_MS: '3000' }), 3000);
    assert.equal(confirmDelayMs({ DOWN_CONFIRM_DELAY_MS: '0' }), 0);
    assert.equal(confirmDelayMs({ DOWN_CONFIRM_DELAY_MS: 'soon' }), 10000);
    assert.equal(confirmDelayMs({ DOWN_CONFIRM_DELAY_MS: '-5' }), 10000);
});

test('the uptime filter leaves out manual and batch checks, and keeps rows that have no checkType', () => {
    assert.deepEqual(SCHEDULED_CHECKS_ONLY, { checkType: { $nin: ['manual', 'batch'] } });
});
