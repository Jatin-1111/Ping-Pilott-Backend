// Run with: npm test
// Regression for F5: when a free trial ended the scheduler just skipped the server. Its last status stayed on the
// dashboard, an open incident never closed, the scheduler read the server every minute for ever, and the owner was
// never told. No database or SMTP: the models and the mailer are fakes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pauseExpiredTrials, expiredTrialFilter, NEVER } from '../services/trialPause.js';

const NOW = new Date('2026-10-24T12:00:00Z');

const chain = (rows) => ({ select: () => chain(rows), limit: () => chain(rows), lean: async () => rows });

// A Server model double: `find` answers come in order (expired first, then un-notified), claims are configurable
const fakeServers = ({ finds = [[], []], claim = (candidate) => ({ ...candidate }) } = {}) => {
    const calls = { find: [], findOneAndUpdate: [], updateMany: [] };
    let findIndex = 0;
    return {
        calls,
        find(filter) { calls.find.push(filter); const rows = finds[findIndex] || []; findIndex += 1; return chain(rows); },
        findOneAndUpdate(filter, update) {
            calls.findOneAndUpdate.push({ filter, update });
            return { lean: async () => claim({ _id: filter._id, uploadedBy: 'u1', name: 'Shop' }) };
        },
        async updateMany(filter, update) { calls.updateMany.push({ filter, update }); return {}; },
    };
};

const fakeIncidents = () => {
    const calls = [];
    return { calls, async updateOne(filter, update) { calls.push({ filter, update }); } };
};

const fakeUsers = (user = { email: 'owner@example.com', displayName: 'Owner' }) => ({ findById: () => ({ select: () => ({ lean: async () => user }) }) });

test('the filter finds free, non-admin servers whose trial ended and that are not paused yet', () => {
    const filter = expiredTrialFilter(NOW);
    assert.equal(filter.uploadedPlan, 'free');
    assert.deepEqual(filter.uploadedRole, { $ne: 'admin' });
    assert.equal(filter.pausedAt, null);
    assert.deepEqual(filter['monitoring.trialEndsAt'], { $lt: NOW });
});

test('an expired trial is paused: status unknown, next check moved out of reach, open incident closed', async () => {
    const servers = fakeServers({ finds: [[{ _id: 's1', uploadedBy: 'u1', name: 'Shop' }], []] });
    const incidents = fakeIncidents();
    const paused = [];

    const result = await pauseExpiredTrials({ servers, incidents, users: fakeUsers(), sendNotice: async () => true, onPaused: async (s) => { paused.push(s._id); }, now: NOW });

    assert.equal(result.paused, 1);
    const { filter, update } = servers.calls.findOneAndUpdate[0];
    assert.deepEqual(filter, { _id: 's1', pausedAt: null }, 'claimed only if nobody paused it first');
    assert.equal(update.$set.status, 'unknown');
    assert.equal(update.$set.pausedAt, NOW);
    assert.equal(update.$set.nextCheckAt, NEVER);
    assert.deepEqual(incidents.calls[0].filter, { serverId: 's1', open: true });
    assert.equal(incidents.calls[0].update.$set.open, false);
    assert.equal(incidents.calls[0].update.$set.endedAt, NOW);
    assert.deepEqual(paused, ['s1'], 'dashboards are told');
});

test('a server another scheduler process already paused is left alone', async () => {
    const servers = fakeServers({ finds: [[{ _id: 's1', uploadedBy: 'u1' }], []], claim: () => null });
    const incidents = fakeIncidents();
    const result = await pauseExpiredTrials({ servers, incidents, users: fakeUsers(), sendNotice: async () => true, now: NOW });
    assert.equal(result.paused, 0);
    assert.equal(incidents.calls.length, 0);
});

test('a failure while tidying up does not stop the other servers', async () => {
    const servers = fakeServers({ finds: [[{ _id: 's1', uploadedBy: 'u1' }, { _id: 's2', uploadedBy: 'u2' }], []] });
    const incidents = { updateOne: async () => { throw new Error('database blip'); } };
    const result = await pauseExpiredTrials({ servers, incidents, users: fakeUsers(), sendNotice: async () => true, now: NOW });
    assert.equal(result.paused, 2);
});

test('each owner gets one email for all their paused servers, then the servers are marked as told', async () => {
    const servers = fakeServers({ finds: [[], [
        { _id: 'a', uploadedBy: 'u1', name: 'One', url: 'one.example.com' },
        { _id: 'b', uploadedBy: 'u1', name: 'Two', url: 'two.example.com' },
        { _id: 'c', uploadedBy: 'u2', name: 'Three', url: 'three.example.com' },
    ]] });
    const sent = [];

    const result = await pauseExpiredTrials({ servers, incidents: fakeIncidents(), users: fakeUsers(), sendNotice: async (user, owned) => { sent.push(owned.map((s) => s._id)); return true; }, now: NOW });

    assert.deepEqual(sent, [['a', 'b'], ['c']]);
    assert.equal(result.notified, 2);
    assert.deepEqual(servers.calls.updateMany[0].filter, { _id: { $in: ['a', 'b'] } });
    assert.equal(servers.calls.updateMany[0].update.$set.trialNoticeSentAt, NOW);
    assert.equal(servers.calls.find[1].trialNoticeSentAt, null, 'only servers not yet told are looked at');
});

test('an email that could not be sent is not marked as sent, so the next run tries again', async () => {
    const servers = fakeServers({ finds: [[], [{ _id: 'a', uploadedBy: 'u1', name: 'One', url: 'one.example.com' }]] });
    const failed = await pauseExpiredTrials({ servers, incidents: fakeIncidents(), users: fakeUsers(), sendNotice: async () => false, now: NOW });
    assert.equal(failed.notified, 0);
    assert.equal(servers.calls.updateMany.length, 0);

    const thrown = await pauseExpiredTrials({ servers: fakeServers({ finds: [[], [{ _id: 'a', uploadedBy: 'u1' }]] }), incidents: fakeIncidents(), users: fakeUsers(), sendNotice: async () => { throw new Error('SMTP down'); }, now: NOW });
    assert.equal(thrown.notified, 0);
});

test('an owner who no longer exists is not retried for ever', async () => {
    const servers = fakeServers({ finds: [[], [{ _id: 'a', uploadedBy: 'gone' }]] });
    const result = await pauseExpiredTrials({ servers, incidents: fakeIncidents(), users: fakeUsers(null), sendNotice: async () => { throw new Error('must not be called'); }, now: NOW });
    assert.equal(result.notified, 1);
    assert.equal(servers.calls.updateMany.length, 1);
});

test('NEVER is far beyond any schedule slot, so the scheduler never picks a paused server up', () => {
    assert.ok(NEVER.getTime() > NOW.getTime() + 365 * 24 * 60 * 60 * 1000 * 100);
});
