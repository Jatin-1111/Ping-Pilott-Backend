// Run with: npm test
// A check is timed until its response is noticed. If this process's own event loop is stalled in between, a healthy
// server reads as slow. A slow check measured during a stall is set aside: stored and shown, never counted toward a slow
// alert. And once a minute the worker says how DNS and the loop are doing.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import mongoose from 'mongoose';
import { createLoadMonitor, loopLagLimitMs, percentile, formatSummary, DEFAULT_LAG_LIMIT_MS } from '../services/loadMonitor.js';
import { runCheck } from '../services/checkRunner.js';
import { decideAlert, planCheckUpdate } from '../utils/alertDecision.js';
import ServerCheck from '../models/ServerCheck.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── the setting ──

test('LOOP_LAG_SUSPECT_MS: unset is 250, a number is used, 0 switches it off, nonsense falls back', () => {
    assert.equal(DEFAULT_LAG_LIMIT_MS, 250);
    assert.equal(loopLagLimitMs({}), 250);
    assert.equal(loopLagLimitMs({ LOOP_LAG_SUSPECT_MS: '500' }), 500);
    assert.equal(loopLagLimitMs({ LOOP_LAG_SUSPECT_MS: '0' }), 0);
    assert.equal(loopLagLimitMs({ LOOP_LAG_SUSPECT_MS: 'lots' }), 250);
    assert.equal(loopLagLimitMs({ LOOP_LAG_SUSPECT_MS: '-1' }), 250);
});

// ── lagSince, with a fake clock and a fake lag source ──

// A monitor whose clock and lag are set by hand. `lag.window` is the lateness of the sampling period that is still open.
const manual = () => {
    let clock = 0;
    const lag = { window: 0 };
    const monitor = createLoadMonitor({
        now: () => clock,
        retainMs: 30000,
        source: () => ({
            peek: () => lag.window,
            read: () => { const value = lag.window; lag.window = 0; return value; }
        })
    });
    // one sampling period that ended at `at` with the worst lateness `ms`
    const period = (at, ms) => { clock = at; lag.window = ms; monitor.sample(); };
    return { monitor, lag, period, setClock: (at) => { clock = at; } };
};

test('lag is the worst of the sampling periods that ended after the check began', () => {
    const { monitor, period } = manual();
    monitor.start();
    period(1000, 10);
    period(2000, 400);
    period(3000, 5);

    assert.equal(monitor.lagSince(500), 400, 'the stall at 2 s is inside a check that began at 0.5 s');
    assert.equal(monitor.lagSince(1500), 400);
    assert.equal(monitor.lagSince(2100), 5, 'a check that began after the stall is not affected by it');
    assert.equal(monitor.lagSince(3500), 0);
    monitor.stop();
});

test('the period still open counts, so a stall in the last moments of a check is not missed', () => {
    const { monitor, lag, period } = manual();
    monitor.start();
    period(1000, 3);
    lag.window = 320; // nothing sampled yet, but the loop has just been 320 ms late
    assert.equal(monitor.lagSince(900), 320);
    monitor.stop();
});

test('old periods are forgotten, and a monitor that was never started reports no lag', () => {
    const { monitor, period } = manual();
    assert.equal(monitor.lagSince(0), 0, 'not started');

    monitor.start();
    period(1000, 500);
    period(40000, 1); // 39 s later: the 1 s period is past the 30 s window
    assert.equal(monitor.lagSince(0), 1);
    monitor.stop();
    assert.equal(monitor.lagSince(0), 0, 'stopped');
});

test('a real stalled event loop is seen as lag, and an idle one is not', async () => {
    const monitor = createLoadMonitor({ intervalMs: 50 });
    monitor.start();
    try {
        await sleep(150);
        const quietFrom = performance.now();
        await sleep(150);
        assert.ok(monitor.lagSince(quietFrom) < 150, `an idle loop is on time, got ${monitor.lagSince(quietFrom)} ms`);

        const checkStarted = performance.now();
        const until = performance.now() + 400;
        while (performance.now() < until) { /* a stalled loop: nothing else runs */ }
        await sleep(120); // let the sampler run again
        const lag = monitor.lagSince(checkStarted);
        assert.ok(lag >= 300, `a 400 ms stall shows as lag, got ${lag} ms`);
    } finally {
        monitor.stop();
    }
});

// ── end to end: a real response that arrives while the loop is blocked ──

test('a real check whose response waits behind a stalled loop is marked, and the same check on a quiet loop is not', async () => {
    process.env.ALLOW_PRIVATE_TARGETS = 'true'; // the guard is not under test; the server is on this machine
    const server = http.createServer(async (req, res) => {
        await sleep(50);
        res.writeHead(200, { 'Content-Length': 2 });
        res.end(req.method === 'HEAD' ? undefined : 'ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;

    const monitor = createLoadMonitor({ intervalMs: 50 });
    monitor.start();
    const options = { lagSince: (since) => monitor.lagSince(since), lagLimitMs: 250, delayMs: 0 };
    const target = { url, type: 'website', status: 'up', monitoring: { alerts: { responseThreshold: 100 } } };

    try {
        await sleep(100);

        // control: a slow answer (50 ms against a 10 ms limit) on a quiet loop
        const quiet = await runCheck({ ...target, monitoring: { alerts: { responseThreshold: 10 } } }, options);
        assert.equal(quiet.status, 'up');
        assert.equal(quiet.slow, true);
        assert.equal(quiet.loadSuspect, undefined, `a quiet loop is not to blame, lag was ${monitor.lagSince(0)} ms`);

        // the server answers at about 50 ms; at 20 ms this process blocks for 350 ms, so the answer is already waiting
        // when the loop comes back, and the check reads about 370 ms
        const stall = setTimeout(() => {
            const until = performance.now() + 350;
            while (performance.now() < until) { /* stalled */ }
        }, 20);
        const stalled = await runCheck(target, options);
        clearTimeout(stall);

        assert.equal(stalled.status, 'up');
        assert.ok(stalled.responseTime >= 300, `it read ${stalled.responseTime} ms for a server that took 50`);
        assert.equal(stalled.slow, true);
        assert.equal(stalled.loadSuspect, true, 'the stall was filed before the waiting response was handled');
    } finally {
        monitor.stop();
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
});

// ── runCheck marks a slow result measured during a stall ──

const SLOW = { status: 'up', responseTime: 1800, error: 'Slow response', slow: true, timings: null };
const FAST = { status: 'up', responseTime: 120, error: null, slow: false, timings: null };
const DOWN = { status: 'down', responseTime: null, error: 'Connection refused', slow: false, timings: null };

const runner = (answers, { lag, limit = 250, status = 'up' } = {}) => {
    let calls = 0;
    const lagCalls = [];
    return {
        lagCalls,
        run: () => runCheck({ status }, {
            check: async () => answers[Math.min(calls++, answers.length - 1)],
            sleep: async () => {},
            isEgressUp: async () => true,
            delayMs: 10000,
            lagSince: (since) => { lagCalls.push(since); return lag; },
            lagLimitMs: limit
        })
    };
};

test('a slow check measured while the loop was 250 ms or more late is marked loadSuspect', async () => {
    const stalled = runner([SLOW], { lag: 400 });
    const result = await stalled.run();
    assert.equal(result.loadSuspect, true);
    assert.equal(result.slow, true, 'it is still slow, and still shown as such');
    assert.equal(result.responseTime, 1800);

    assert.equal((await runner([SLOW], { lag: 250 }).run()).loadSuspect, true, '250 ms exactly is the line');
    assert.equal((await runner([SLOW], { lag: 249 }).run()).loadSuspect, undefined);
});

test('a quick check is never marked, however busy the loop was', async () => {
    assert.equal((await runner([FAST], { lag: 5000 }).run()).loadSuspect, undefined);
});

test('the guard can be switched off with a limit of 0', async () => {
    assert.equal((await runner([SLOW], { lag: 5000, limit: 0 }).run()).loadSuspect, undefined);
});

test('lag is measured from when the check began, on the same clock', async () => {
    const before = performance.now();
    const r = runner([SLOW], { lag: 10 });
    await r.run();
    assert.equal(r.lagCalls.length, 1);
    assert.ok(r.lagCalls[0] >= before && r.lagCalls[0] <= performance.now());
});

test('the confirmation check is judged by its own stall, not the first one\'s', async () => {
    // down, then slow while stalled: the answer that counts is the second, and it is marked
    const result = await runner([DOWN, SLOW], { lag: 400 }).run();
    assert.equal(result.status, 'up');
    assert.equal(result.loadSuspect, true);

    // a failure is not marked: the second attempt and the egress probe are what vouch for it
    const down = await runner([DOWN, DOWN], { lag: 400 }).run();
    assert.equal(down.status, 'down');
    assert.equal(down.loadSuspect, undefined);
});

// ── a flagged sample is set aside in the slow streak ──

const SLOW_SUSPECT = { ...SLOW, loadSuspect: true };

const run = (results, { frequency = 5, start = {} } = {}) => {
    let state = { slowAlerted: false, slowStreak: 0, fastStreak: 0, ...start };
    let status = 'up';
    const alerts = [];
    for (const result of results) {
        const decision = decideAlert(status, result, state, { frequency });
        alerts.push(decision.alertType);
        if (decision.touchStreak) state = { slowAlerted: decision.slowAlerted, slowStreak: decision.slowStreak, fastStreak: decision.fastStreak };
        status = result.status;
    }
    return { alerts, state };
};

test('a slow sample taken during a stall neither builds the streak nor breaks it', () => {
    // two real slow checks, a stalled one, then the third real one: the alert comes on the third REAL slow check
    assert.deepEqual(run([SLOW, SLOW, SLOW_SUSPECT, SLOW]).alerts, [null, null, null, 'slow_response']);

    // stalled samples alone never alert
    assert.deepEqual(run([SLOW_SUSPECT, SLOW_SUSPECT, SLOW_SUSPECT, SLOW_SUSPECT]).alerts, [null, null, null, null]);

    // and a stalled one does not reset a streak that was building
    const mid = run([SLOW, SLOW]).state;
    const after = run([SLOW_SUSPECT], { start: mid }).state;
    assert.deepEqual([after.slowStreak, after.fastStreak], [2, 0]);
});

test('a stalled slow sample does not count toward closing an open alert either', () => {
    const open = run([SLOW, SLOW, SLOW]).state;
    // set aside means neither: it does not count as quick, and it does not undo the quick check before it
    assert.equal(run([FAST, SLOW_SUSPECT], { start: open }).state.slowAlerted, true, 'one quick check is still not enough');
    assert.equal(run([SLOW_SUSPECT, SLOW_SUSPECT, SLOW_SUSPECT], { start: open }).state.slowAlerted, true, 'stalled samples alone never close it');
    assert.equal(run([FAST, SLOW_SUSPECT, FAST], { start: open }).state.slowAlerted, false, 'two quick ones with a set-aside sample between them');
    assert.equal(run([FAST, FAST], { start: open }).state.slowAlerted, false);
});

test('a stalled sample on a recovery starts no streak, and a plain slow one still does', () => {
    const afterOutage = decideAlert('down', SLOW_SUSPECT, { slowStreak: 0 }, { frequency: 5 });
    assert.equal(afterOutage.alertType, 'server_recovery');
    assert.deepEqual([afterOutage.slowStreak, afterOutage.fastStreak], [0, 0]);
    assert.equal(decideAlert('down', SLOW, {}, { frequency: 5 }).slowStreak, 1);
});

test('the write for a set-aside sample leaves the counters out, but still shows the latest time', () => {
    const NOW = new Date('2026-10-25T10:00:00Z');
    const plan = planCheckUpdate({ server: { _id: 's1', status: 'up', slowStreak: 2, monitoring: { frequency: 5 } }, checkResult: SLOW_SUSPECT, now: NOW });
    assert.equal(plan.alertType, null);
    for (const field of ['slowAlerted', 'slowStreak', 'fastStreak']) assert.equal(field in plan.$set, false, field);
    assert.equal(plan.$set.responseTime, 1800);
});

// ── the minute's summary ──

test('percentiles use the nearest rank, and an empty list has none', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentile(hundred, 50), 50);
    assert.equal(percentile(hundred, 95), 95);
    assert.equal(percentile(hundred, 100), 100);
    assert.equal(percentile([7], 95), 7);
    assert.equal(percentile([], 50), null);
    assert.deepEqual(hundred.slice(0, 3), [1, 2, 3], 'the input is not reordered');
});

test('the summary covers the checks and lag of the minute, then starts again', () => {
    const { monitor, period } = manual();
    monitor.start();

    for (let i = 1; i <= 100; i += 1) monitor.recordCheck({ timings: { dns: i, ttfb: 50 } });
    monitor.recordCheck({ timings: null, loadSuspect: true }); // a failed check or an old one: counted, no DNS time
    period(1000, 4);
    period(2000, 12);
    period(3000, 8);

    const summary = monitor.summarize();
    assert.equal(summary.checks, 101);
    assert.equal(summary.setAside, 1);
    assert.deepEqual(summary.dns, { p50: 50, p95: 95, max: 100 }, 'the 100 DNS times 1..100; the check without timings adds none');
    assert.deepEqual(summary.lag, { p95: 12, max: 12 });

    assert.equal(monitor.summarize(), null, 'a new minute with no checks says nothing');
    monitor.stop();
});

test('the summary line is one line of plain words, and nothing when there were no checks', () => {
    assert.equal(formatSummary(null), null);
    assert.equal(
        formatSummary({ checks: 118, setAside: 0, dns: { p50: 3, p95: 41, max: 220 }, lag: { p95: 4, max: 12 } }),
        'Checks, last minute: 118 (DNS p50 3 ms, p95 41 ms, max 220 ms; event-loop lag p95 4 ms, max 12 ms; 0 slow ones set aside while the loop was busy)'
    );
    const one = formatSummary({ checks: 2, setAside: 1, dns: null, lag: null });
    assert.match(one, /no DNS times; no loop lag samples; 1 slow one set aside/);
    assert.equal(one.includes('\n'), false);
});

test('a stored check can carry loadSuspect, and has no such field otherwise', () => {
    const flagged = new ServerCheck({ serverId: new mongoose.Types.ObjectId(), status: 'up', responseTime: 1800, loadSuspect: true });
    assert.equal(flagged.validateSync(), undefined);
    assert.equal(flagged.toObject().loadSuspect, true);
    assert.equal(new ServerCheck({ serverId: new mongoose.Types.ObjectId(), status: 'up' }).toObject().loadSuspect, undefined);
});
