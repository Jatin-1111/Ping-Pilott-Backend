// Run with: npm test
// The sweep that tells an owner when their host agent has gone quiet.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runHostMissingSweep } from '../tasks/hostMissing.js';

const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-26T12:30:00Z');
const pro = { _id: 'u-pro', role: 'user', subscription: { plan: 'pro_monthly' } };
const free = { _id: 'u-free', role: 'user', subscription: { plan: 'free' } };

const server = (id, over = {}) => ({
    _id: id, name: `Server ${id}`, uploadedBy: pro._id, status: 'up',
    agent: { enabled: true, lastSeenAt: new Date(NOW - 12 * MIN), alertsRev: 3, alerts: { cpu: { since: null, alerted: false } } },
    ...over
});

/** A world with the servers the database would return, and a record of what the sweep did */
const world = (servers, { owners = [pro, free], canAlert = () => true, saveLosesFor = [], enqueueFailsFor = [] } = {}) => {
    const log = { cutoffs: [], ownerLookups: [], saved: [], enqueued: [] };
    return {
        log,
        deps: {
            now: () => NOW,
            findQuiet: async (cutoff) => { log.cutoffs.push(cutoff.getTime()); return servers; },
            findOwners: async (ids) => { log.ownerLookups.push(ids); return owners.filter((o) => ids.includes(String(o._id))); },
            saveState: async (id, state, rev) => {
                if (saveLosesFor.includes(id)) return false;
                log.saved.push({ id, state, rev });
                return true;
            },
            shouldSend: (s) => canAlert(s),
            enqueueAlert: async (args) => {
                if (enqueueFailsFor.includes(args.server._id)) throw new Error('the queue is down');
                log.enqueued.push(args);
            }
        }
    };
};

test('an agent quiet for longer than its limit is reported once, with how long and when it was last heard', async () => {
    const w = world([server('a')]);
    const result = await runHostMissingSweep(w.deps);
    assert.deepEqual(result, { checked: 1, raised: 1 });

    const [{ alertType, checkResult, server: s, previous }] = w.log.enqueued;
    assert.equal(alertType, 'host_metrics_missing');
    assert.equal(previous, 'up');
    assert.equal(checkResult.host.minutes, 12);
    assert.equal(checkResult.host.recovered, false);
    assert.equal(checkResult.host.lastSeen, new Date(NOW - 12 * MIN).toISOString());
    assert.equal(s._id, 'a');
    assert.equal('alsoDown' in checkResult.host, false);

    const [{ state, rev }] = w.log.saved;
    assert.equal(rev, 3, 'saved against the state it read');
    assert.deepEqual(state.missing, { alerted: true, alertedAt: NOW, since: NOW - 12 * MIN });
    assert.deepEqual(state.cpu, { since: null, alerted: false }, 'the other alerts\' state is kept');
});

test('the sweep reads servers quiet for at least the shortest limit anyone can set, and nothing more', async () => {
    const w = world([]);
    assert.deepEqual(await runHostMissingSweep(w.deps), { checked: 0, raised: 0 });
    assert.deepEqual(w.log.cutoffs, [NOW - 2 * MIN]);
    assert.deepEqual(w.log.ownerLookups, [], 'nobody to look up when nothing is quiet');
});

test('each owner is looked up once, however many servers they have', async () => {
    const w = world([server('a'), server('b'), server('c', { uploadedBy: free._id })]);
    await runHostMissingSweep(w.deps);
    assert.equal(w.log.ownerLookups.length, 1);
    assert.deepEqual(w.log.ownerLookups[0].sort(), ['u-free', 'u-pro']);
});

test('not before the owner\'s own limit, which they may have made longer', async () => {
    const w = world([server('a', { monitoring: { hostAlerts: { missing: { minutes: 30 } } } })]);
    assert.equal((await runHostMissingSweep(w.deps)).raised, 0);
    const shorter = world([server('b', { monitoring: { hostAlerts: { missing: { minutes: 10 } } } })]);
    assert.equal((await runHostMissingSweep(shorter.deps)).raised, 1);
});

test('an agent that has never reported is not "quiet": it has not been installed yet', async () => {
    const w = world([server('a', { agent: { enabled: true, alerts: {}, alertsRev: 0 } })]);
    assert.equal((await runHostMissingSweep(w.deps)).raised, 0);
});

test('one that has been told already is not told again', async () => {
    const w = world([server('a', { agent: { enabled: true, lastSeenAt: new Date(NOW - 60 * MIN), alertsRev: 4, alerts: { missing: { alerted: true } } } })]);
    assert.equal((await runHostMissingSweep(w.deps)).raised, 0);
    assert.deepEqual(w.log.enqueued, []);
});

test('host alerts that the owner switched off are not raised', async () => {
    const w = world([server('a', { monitoring: { hostAlerts: { enabled: false } } })]);
    assert.equal((await runHostMissingSweep(w.deps)).raised, 0);
});

test('an owner whose plan no longer includes agents is not told, since ingest refuses the agent and of course it is quiet', async () => {
    const w = world([server('a', { uploadedBy: free._id }), server('b', { uploadedBy: 'someone-who-was-deleted' })]);
    assert.equal((await runHostMissingSweep(w.deps)).raised, 0);
});

test('when the owner cannot be told right now nothing is used up, and the next sweep tells them', async () => {
    let open = false;
    const w = world([server('a')], { canAlert: () => open });
    assert.equal((await runHostMissingSweep(w.deps)).raised, 0);
    assert.deepEqual(w.log.saved, [], 'no state was written, so the alert is still to come');
    open = true;
    assert.equal((await runHostMissingSweep(w.deps)).raised, 1);
});

test('two processes sweeping at once raise it once: the one that loses the save raises nothing', async () => {
    const w = world([server('a'), server('b')], { saveLosesFor: ['a'] });
    const result = await runHostMissingSweep(w.deps);
    assert.equal(result.raised, 1);
    assert.deepEqual(w.log.enqueued.map((e) => e.server._id), ['b']);
});

test('when the checks also see the server down, the alert says the whole machine may be off', async () => {
    const w = world([server('a', { status: 'down' })]);
    await runHostMissingSweep(w.deps);
    assert.equal(w.log.enqueued[0].checkResult.host.alsoDown, true);
    assert.equal(w.log.enqueued[0].previous, 'down');
});

test('a problem with one server does not stop the others, and is not counted as an alert', async () => {
    const w = world([server('a'), server('b'), server('c')], { enqueueFailsFor: ['a'] });
    const result = await runHostMissingSweep(w.deps);
    assert.equal(result.raised, 2);
    assert.deepEqual(w.log.enqueued.map((e) => e.server._id), ['b', 'c']);
});
