// Run with: npm test
// A server that keeps going up and down must not send an email each time. After FLAP_CHANGES changes within
// FLAP_WINDOW_MINUTES its down and recovery alerts are held; the alert that starts the hold says so; the hold ends after
// FLAP_STEADY_MINUTES without a change, with one alert if the owner is then behind. No new alert type.

import test from 'node:test';
import assert from 'node:assert/strict';
import { flapConfig, dampAlert, describeFlap, cleanFlap } from '../utils/flapDamping.js';
import { decideAlert, planCheckUpdate } from '../utils/alertDecision.js';
import { buildAlertMessage } from '../utils/alertFeed.js';
import { enqueueAlert } from '../services/alertOutbox.js';
import { sendAlertChannels } from '../services/alertService.js';
import Server from '../models/Server.js';

const T0 = Date.parse('2026-10-25T10:00:00Z');
const at = (minute) => T0 + minute * 60 * 1000;
const DEFAULT = flapConfig({});

/** Replay a list of checks through the plain rules and the damping, saving the state between them as the recorder does */
function replay(steps, { config = DEFAULT, from = 'up', state: initial } = {}) {
    let state = { alertedStatus: null, statusChanges: [], flapHeldAt: null, ...initial };
    let status = from;
    const log = [];
    for (const [minute, next] of steps) {
        const base = decideAlert(status, { status: next, slow: false }, {}, { frequency: 5 }).alertType;
        const out = dampAlert({ previous: status, status: next, baseAlertType: base, state, now: at(minute), config });
        if (out.touch) state = { alertedStatus: out.alertedStatus, statusChanges: out.statusChanges, flapHeldAt: out.flapHeldAt };
        log.push({ minute, status: next, alert: out.alertType, flap: out.flap?.state ?? null, release: out.release });
        status = next;
    }
    return { log, state, alerts: log.filter((l) => l.alert) };
}

const alertsOf = (result) => result.alerts.map((a) => `${a.minute}:${a.alert}${a.flap ? `(${a.flap})` : ''}`);

// ── the setting ──

test('the settings: 4 changes in 30 minutes, steady for 10; 0 switches it off; nonsense falls back', () => {
    assert.deepEqual([DEFAULT.changes, DEFAULT.windowMinutes, DEFAULT.steadyMinutes, DEFAULT.windowMs, DEFAULT.steadyMs], [4, 30, 10, 1800000, 600000]);
    const custom = flapConfig({ FLAP_CHANGES: '6', FLAP_WINDOW_MINUTES: '60', FLAP_STEADY_MINUTES: '15' });
    assert.deepEqual([custom.changes, custom.windowMinutes, custom.steadyMinutes], [6, 60, 15]);
    assert.equal(flapConfig({ FLAP_CHANGES: '0' }).changes, 0);
    for (const junk of ['lots', '-2', '']) {
        const c = flapConfig({ FLAP_CHANGES: junk, FLAP_WINDOW_MINUTES: junk, FLAP_STEADY_MINUTES: junk });
        assert.deepEqual([c.changes, c.windowMinutes, c.steadyMinutes], [4, 30, 10], `"${junk}"`);
    }
});

// ── ordinary behaviour is untouched ──

test('one outage is one DOWN and one RECOVERY, with no hold', () => {
    const r = replay([[0, 'up'], [5, 'down'], [10, 'down'], [15, 'up'], [20, 'up']]);
    assert.deepEqual(alertsOf(r), ['5:server_down', '15:server_recovery']);
    assert.equal(r.state.flapHeldAt, null);
});

test('changes more than 30 minutes apart never start a hold', () => {
    const r = replay([[0, 'down'], [31, 'up'], [62, 'down'], [93, 'up'], [124, 'down']]);
    assert.equal(r.alerts.length, 5, 'every change alerts');
    assert.ok(r.alerts.every((a) => !a.flap));
    assert.equal(r.state.flapHeldAt, null);
});

test('the window is 30 minutes inclusive: four changes in exactly 30 hold, a 31 minute spread does not', () => {
    assert.deepEqual(alertsOf(replay([[0, 'down'], [10, 'up'], [20, 'down'], [30, 'up']])).slice(-1), ['30:server_recovery(started)']);
    const slower = replay([[0, 'down'], [10, 'up'], [20, 'down'], [31, 'up']]);
    assert.ok(slower.alerts.every((a) => !a.flap), 'the first change had left the window');
    assert.equal(slower.state.flapHeldAt, null);
});

// ── a flapping server ──

test('the 4th change in the window alerts once, says it starts a hold, and the changes after it are held', () => {
    const r = replay([[0, 'down'], [5, 'up'], [10, 'down'], [15, 'up'], [20, 'down'], [25, 'up'], [30, 'down']]);
    assert.deepEqual(alertsOf(r), ['0:server_down', '5:server_recovery', '10:server_down', '15:server_recovery(started)']);
    assert.equal(r.log.find((l) => l.minute === 15).alert, 'server_recovery', 'an existing alert type, not a new one');
    assert.ok(r.state.flapHeldAt, 'still held');
    assert.equal(r.state.alertedStatus, 'up', 'the owner was last told it is up');
});

test('when it settles for 10 minutes, one alert says where it ended up', () => {
    const r = replay([[0, 'down'], [5, 'up'], [10, 'down'], [15, 'up'], [20, 'down'], [25, 'up'], [30, 'down'], [35, 'down'], [39, 'down'], [40, 'down'], [45, 'down']]);
    assert.deepEqual(alertsOf(r), ['0:server_down', '5:server_recovery', '10:server_down', '15:server_recovery(started)', '40:server_down(settled)']);
    assert.equal(r.log.find((l) => l.minute === 39).alert, null, 'nine minutes steady is not enough');
    assert.equal(r.log.find((l) => l.minute === 40).release, true, 'ten minutes is');
    assert.equal(r.state.flapHeldAt, null);
    assert.deepEqual(r.state.statusChanges, [], 'a fresh slate after it settles');
    assert.equal(r.state.alertedStatus, 'down');
});

test('if it settles where the owner was last told, the hold ends with no alert', () => {
    const r = replay([[0, 'down'], [5, 'up'], [10, 'down'], [15, 'up'], [20, 'down'], [25, 'up'], [30, 'up'], [35, 'up'], [36, 'up']]);
    assert.deepEqual(alertsOf(r), ['0:server_down', '5:server_recovery', '10:server_down', '15:server_recovery(started)']);
    assert.equal(r.log.find((l) => l.minute === 35).release, true, 'released, ten minutes after the last change at 25');
    assert.equal(r.state.flapHeldAt, null);
});

test('a real outage that begins during a hold is reported ten minutes after it settles, not before', () => {
    const r = replay([[0, 'down'], [5, 'up'], [10, 'down'], [15, 'up'], [20, 'down'], [25, 'down'], [29, 'down'], [30, 'down']]);
    // the last change was at 20: ten minutes later, at 30, the owner hears it is down
    assert.deepEqual(alertsOf(r).slice(-1), ['30:server_down(settled)']);
    assert.equal(r.log.find((l) => l.minute === 29).alert, null);
});

test('a hold left from before a long gap ends at the next check, with an alert if the owner is behind', () => {
    const r = replay([[500, 'down']], { from: 'down', state: { alertedStatus: 'up', statusChanges: [], flapHeldAt: at(0) } });
    assert.deepEqual(alertsOf(r), ['500:server_down(settled)']);
    assert.equal(r.state.flapHeldAt, null);
});

test('only up <-> down counts as a change: the first check of a server (unknown) does not', () => {
    const r = replay([[0, 'down'], [5, 'up'], [10, 'down'], [15, 'up']], { from: 'unknown' });
    assert.equal(r.state.flapHeldAt, null, 'unknown -> down, then three changes: not four');
    assert.deepEqual(alertsOf(r), ['0:server_down', '5:server_recovery', '10:server_down', '15:server_recovery']);
    assert.equal(r.state.alertedStatus, 'up');
    assert.equal(replay([[0, 'down'], [5, 'up'], [10, 'down'], [15, 'up'], [20, 'down']], { from: 'unknown' }).log[4].flap, 'started');
});

test('slow alerts are never held, whatever the damping is doing', () => {
    const held = { alertedStatus: 'up', statusChanges: [at(0), at(5), at(10), at(15)], flapHeldAt: at(15) };
    const out = dampAlert({ previous: 'up', status: 'up', baseAlertType: 'slow_response', state: held, now: at(17), config: DEFAULT });
    assert.equal(out.alertType, 'slow_response');
    assert.equal(out.touch, false);
    const free = dampAlert({ previous: 'up', status: 'up', baseAlertType: 'slow_response', state: {}, now: at(17), config: DEFAULT });
    assert.equal(free.alertType, 'slow_response');
});

test('with FLAP_CHANGES=0 every change alerts, as before, and a leftover hold is dropped', () => {
    const off = flapConfig({ FLAP_CHANGES: '0' });
    const r = replay([[0, 'down'], [5, 'up'], [10, 'down'], [15, 'up'], [20, 'down'], [25, 'up'], [30, 'down']], { config: off });
    assert.equal(r.alerts.length, 7);
    assert.ok(r.alerts.every((a) => !a.flap));

    const dropped = dampAlert({ previous: 'up', status: 'up', baseAlertType: null, state: { flapHeldAt: at(0), statusChanges: [at(0)] }, now: at(60), config: off });
    assert.equal(dropped.flapHeldAt, null);
    assert.equal(dropped.touch, true);
});

// ── what is written ──

const NOW = new Date(at(15));
const serverAt = (extra = {}) => ({ _id: 's1', status: 'down', monitoring: { frequency: 5 }, ...extra });
const UP = { status: 'up', responseTime: 120, error: null, slow: false, failure: null };
const DOWN = { status: 'down', responseTime: null, error: 'Connection refused', slow: false, failure: { kind: 'refused' } };

test('an ordinary check writes none of the damping state', () => {
    const plan = planCheckUpdate({ server: serverAt({ status: 'up' }), checkResult: UP, now: NOW });
    for (const field of ['alertedStatus', 'statusChanges', 'flapHeldAt']) assert.equal(field in plan.$set, false, field);
    assert.equal(plan.alertType, null);
    assert.equal(plan.flap, null);
});

test('the change that starts a hold writes the state, keeps its status guard, and carries the note', () => {
    const server = serverAt({ status: 'down', alertedStatus: 'down', statusChanges: [new Date(at(0)), new Date(at(5)), new Date(at(10))], flapHeldAt: null });
    const plan = planCheckUpdate({ server, checkResult: UP, now: NOW });

    assert.equal(plan.alertType, 'server_recovery');
    assert.deepEqual(plan.flap, { state: 'started', changes: 4, windowMinutes: 30, steadyMinutes: 10 });
    assert.equal(plan.$set.alertedStatus, 'up');
    assert.deepEqual(plan.$set.statusChanges, [0, 5, 10, 15].map((m) => new Date(at(m))));
    assert.deepEqual(plan.$set.flapHeldAt, NOW);
    assert.deepEqual(plan.filter, { _id: 's1', status: 'down' });
    assert.equal(plan.changed, true, 'the incident still closes');
});

test('a change while held writes the history but sends nothing, and the status still changes', () => {
    const server = serverAt({ status: 'up', alertedStatus: 'up', statusChanges: [new Date(at(0)), new Date(at(5)), new Date(at(10)), new Date(at(12))], flapHeldAt: new Date(at(12)) });
    const plan = planCheckUpdate({ server, checkResult: DOWN, now: NOW });

    assert.equal(plan.alertType, null);
    assert.equal(plan.changed, true, 'the incident still opens, and the history is true');
    assert.equal(plan.$set.status, 'down');
    assert.equal(plan.$set.statusChanges.length, 5);
    assert.deepEqual(plan.$set.flapHeldAt, new Date(at(12)), 'still held since it began');
    assert.equal(plan.$set.alertedStatus, 'up', 'the owner has still only been told "up"');
    assert.deepEqual(plan.filter, { _id: 's1', status: 'up' });
});

test('the check that ends a hold is guarded so two racing checks send one alert', () => {
    const server = serverAt({ status: 'down', alertedStatus: 'up', statusChanges: [new Date(at(0)), new Date(at(5))], flapHeldAt: new Date(at(0)) });
    const plan = planCheckUpdate({ server, checkResult: DOWN, now: NOW });

    assert.equal(plan.alertType, 'server_down');
    assert.equal(plan.flap.state, 'settled');
    assert.deepEqual(plan.filter, { _id: 's1', flapHeldAt: { $ne: null } }, 'it only applies while the server is still held');
    assert.equal(plan.$set.flapHeldAt, null);
    assert.deepEqual(plan.$set.statusChanges, []);
    assert.equal(plan.$set.alertedStatus, 'down');
});

test('a manual or batch check is damped the same way', () => {
    const server = serverAt({ status: 'up', alertedStatus: 'up', statusChanges: [new Date(at(0)), new Date(at(5)), new Date(at(10)), new Date(at(12))], flapHeldAt: new Date(at(12)) });
    for (const checkType of ['manual', 'batch']) {
        assert.equal(planCheckUpdate({ server, checkResult: DOWN, checkType, now: NOW }).alertType, null, checkType);
    }
});

test('the damping can be switched off for a plan', () => {
    const server = serverAt({ status: 'down', alertedStatus: 'down', statusChanges: [new Date(at(0)), new Date(at(5)), new Date(at(10))] });
    const plan = planCheckUpdate({ server, checkResult: UP, now: NOW, flapSettings: flapConfig({ FLAP_CHANGES: '0' }) });
    assert.equal(plan.alertType, 'server_recovery');
    assert.equal(plan.flap, null);
});

// ── what the alerts say ──

const STARTED = { state: 'started', changes: 4, windowMinutes: 30, steadyMinutes: 10 };
const SETTLED = { state: 'settled', changes: 6, windowMinutes: 30, steadyMinutes: 10 };

test('the sentences', () => {
    assert.equal(describeFlap(STARTED), 'It has changed state 4 times in 30 minutes, so further changes are held until it stays steady for 10 minutes.');
    assert.equal(describeFlap(SETTLED), 'It had been changing state repeatedly and has now been steady for 10 minutes.');
    assert.equal(describeFlap(null), null);
    assert.equal(describeFlap({ state: 'weird', changes: 4, windowMinutes: 30, steadyMinutes: 10 }), null);
    assert.equal(describeFlap({ state: 'started', changes: 'x', windowMinutes: 30, steadyMinutes: 10 }), null);
});

test('cleanFlap keeps the four known fields and drops anything else', () => {
    assert.deepEqual(cleanFlap({ ...STARTED, junk: 1 }), STARTED);
    assert.equal(cleanFlap({ state: 'started' }), null);
    assert.equal(cleanFlap('started'), null);
});

test('the feed message of a down or recovery alert adds the note, and keeps it whole when the error is long', () => {
    assert.equal(
        buildAlertMessage('server_down', { error: 'Connection refused', flap: STARTED }),
        `Connection refused ${describeFlap(STARTED)}`
    );
    assert.equal(
        buildAlertMessage('server_recovery', { responseTime: 212, flap: SETTLED }),
        `Back online, responding in 212 ms. ${describeFlap(SETTLED)}`
    );

    const long = buildAlertMessage('server_down', { error: 'x'.repeat(1000), flap: STARTED });
    assert.equal(long.length, 300);
    assert.ok(long.endsWith(describeFlap(STARTED)), 'the error is what is cut, not the note');

    // without a note, nothing changes
    assert.equal(buildAlertMessage('server_down', { error: 'Connection refused' }), 'Connection refused');
    assert.equal(buildAlertMessage('server_down', { error: 'x'.repeat(1000) }).length, 300);
    assert.equal(buildAlertMessage('slow_response', { responseTime: 2000, flap: STARTED }, {}), 'Responded in 2000 ms.', 'slow alerts never carry it');
});

test('the alert row keeps the note, and the webhook payload carries it', async () => {
    let row;
    const model = { create: async (doc) => { row = doc; return { _id: 'p1', serverId: doc.serverId, alertType: doc.alertType, priority: doc.priority }; }, updateOne: async () => ({}) };
    await enqueueAlert(
        { server: { _id: 's1', uploadedBy: 'u1' }, alertType: 'server_recovery', previous: 'down', checkResult: { ...UP, flap: { ...STARTED, junk: 1 } } },
        { model, queue: { add: async () => ({}) }, shouldSend: () => true }
    );
    assert.deepEqual(row.checkResult.flap, STARTED);

    const send = async (checkResult) => {
        let payload;
        await sendAlertChannels(
            { _id: 's1', name: 'Shop', url: 'shop.example', status: 'down', contactEmails: [], monitoring: { alerts: { webhookUrl: 'https://hooks.example/x' } } },
            'server_recovery', checkResult, {},
            { sendWebhook: async (_s, _t, body) => { payload = body; }, sendEmail: async () => {} }
        );
        return payload;
    };
    assert.deepEqual((await send(row.checkResult)).flap, STARTED);
    assert.equal('flap' in (await send({ status: 'up', responseTime: 100 })), false, 'an ordinary alert keeps the payload it always had');
});

test('a server has the damping fields with empty defaults, and an alertedStatus must be up, down or empty', () => {
    const base = { name: 'a', url: 'a.com', uploadedBy: '5f1d7f3a8f3c2a1b4c8e9d10' };
    const fresh = new Server(base);
    assert.equal(fresh.alertedStatus, null);
    assert.deepEqual([...fresh.statusChanges], []);
    assert.equal(fresh.flapHeldAt, null);
    assert.equal(fresh.validateSync(), undefined);
    assert.ok(new Server({ ...base, alertedStatus: 'unknown' }).validateSync()?.errors?.alertedStatus);
    assert.equal(new Server({ ...base, alertedStatus: 'down' }).validateSync(), undefined);
});
