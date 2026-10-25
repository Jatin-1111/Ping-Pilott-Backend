// Run with: npm test
// These cover the incident rules without a database: a fake model stands in for Incident.

import test from 'node:test';
import assert from 'node:assert/strict';
import { incidentAction, trimError, recordStatusChange } from '../services/incidentService.js';

const server = { _id: 'srv1', uploadedBy: 'user1', name: 'Northwind API' };
const NOW = new Date('2026-10-24T09:41:00Z');

const fakeModel = () => {
    const calls = { create: [], updateOne: [] };
    return {
        calls,
        create: async (doc) => { calls.create.push(doc); },
        updateOne: async (filter, update) => { calls.updateOne.push({ filter, update }); },
    };
};

test('only going down opens an incident, and leaving down closes it', () => {
    assert.equal(incidentAction('up', 'down'), 'open');
    assert.equal(incidentAction('unknown', 'down'), 'open');
    assert.equal(incidentAction('down', 'up'), 'close');
    assert.equal(incidentAction('down', 'unknown'), 'close');
});

test('no change in status, or a change that does not involve down, does nothing', () => {
    assert.equal(incidentAction('down', 'down'), null);
    assert.equal(incidentAction('up', 'up'), null);
    assert.equal(incidentAction('up', 'unknown'), null);
    assert.equal(incidentAction('unknown', 'up'), null);
});

test('errors are cut to 300 characters, and empty ones become null', () => {
    assert.equal(trimError('x'.repeat(1000)).length, 300);
    assert.equal(trimError('timeout'), 'timeout');
    assert.equal(trimError(''), null);
    assert.equal(trimError(undefined), null);
});

test('going down opens an incident for the owner, starting now, with the error', async () => {
    const model = fakeModel();
    await recordStatusChange(server, 'up', { status: 'down', error: 'Request timed out' }, NOW, model);
    assert.equal(model.calls.create.length, 1);
    assert.deepEqual(model.calls.create[0], {
        serverId: 'srv1',
        userId: 'user1',
        startedAt: NOW,
        error: 'Request timed out',
        failureKind: null,
        open: true,
    });
    assert.equal(model.calls.updateOne.length, 0);
});

test('recovering closes the open incident of that server and sets the end time', async () => {
    const model = fakeModel();
    await recordStatusChange(server, 'down', { status: 'up', error: null }, NOW, model);
    assert.equal(model.calls.create.length, 0);
    assert.deepEqual(model.calls.updateOne[0].filter, { serverId: 'srv1', open: true });
    assert.deepEqual(model.calls.updateOne[0].update, { $set: { endedAt: NOW, open: false } });
});

test('a check that changes nothing writes nothing', async () => {
    const model = fakeModel();
    await recordStatusChange(server, 'down', { status: 'down', error: 'still failing' }, NOW, model);
    await recordStatusChange(server, 'up', { status: 'up' }, NOW, model);
    assert.equal(model.calls.create.length + model.calls.updateOne.length, 0);
});

test('a racing duplicate (unique index) is not an error', async () => {
    const model = { create: async () => { const e = new Error('E11000 duplicate key'); e.code = 11000; throw e; } };
    await assert.doesNotReject(recordStatusChange(server, 'up', { status: 'down' }, NOW, model));
});

test('a database failure never reaches the check that triggered it', async () => {
    const model = {
        create: async () => { throw new Error('connection lost'); },
        updateOne: async () => { throw new Error('connection lost'); },
    };
    await assert.doesNotReject(recordStatusChange(server, 'up', { status: 'down' }, NOW, model));
    await assert.doesNotReject(recordStatusChange(server, 'down', { status: 'up' }, NOW, model));
});
