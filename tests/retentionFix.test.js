// Run with: npm test
// The TTL index the model declared on the time-series field was never created (MongoDB does not accept it), so the
// 30 day backstop did not exist. The model now sets expireAfterSeconds as a collection option, and an existing
// collection gets it once with collMod. No database: the Db is a fake.

import test from 'node:test';
import assert from 'node:assert/strict';
import ServerCheck from '../models/ServerCheck.js';
import { planTtlChange, applyTtlChange, TARGET_TTL_SECONDS } from '../services/retentionFix.js';

const DAYS_30 = 30 * 24 * 60 * 60;

test('the model asks for a 30 day TTL as a collection option, and declares no TTL index', () => {
    assert.equal(ServerCheck.schema.options.expireAfterSeconds, DAYS_30);
    assert.deepEqual(ServerCheck.schema.options.timeseries, { timeField: 'timestamp', metaField: 'serverId', granularity: 'minutes' });

    const ttlIndexes = ServerCheck.schema.indexes().filter(([, options]) => options && options.expireAfterSeconds !== undefined);
    assert.deepEqual(ttlIndexes, [], 'a TTL index on the time field is not accepted on a time-series collection');
});

test('the target is 30 days', () => {
    assert.equal(TARGET_TTL_SECONDS, DAYS_30);
});

test('a collection with no TTL is planned for a change', () => {
    const plan = planTtlChange({ info: { options: { timeseries: { timeField: 'timestamp' } } } });
    assert.equal(plan.action, 'set');
    assert.equal(plan.current, null);
    assert.match(plan.reason, /No TTL is set.*30 days/);
});

test('a different TTL is planned for a change, and says from what', () => {
    const plan = planTtlChange({ info: { options: { timeseries: {}, expireAfterSeconds: 7 * 86400 } } });
    assert.equal(plan.action, 'set');
    assert.equal(plan.current, 7 * 86400);
    assert.match(plan.reason, /changed to/);
});

test('a collection that already has the TTL is left alone', () => {
    const plan = planTtlChange({ info: { options: { timeseries: {}, expireAfterSeconds: DAYS_30 } } });
    assert.equal(plan.action, 'none');
    assert.match(plan.reason, /already/);
});

test('a missing collection is left alone: it is created with the TTL on first use', () => {
    assert.equal(planTtlChange({ info: undefined }).action, 'none');
});

test('a collection that is not time-series is not touched, and the script reports it as a problem', () => {
    const plan = planTtlChange({ info: { options: {} } });
    assert.equal(plan.action, 'cannot');
    assert.match(plan.reason, /Nothing was changed/);
});

test('applying runs one collMod on serverchecks with the target and nothing else', async () => {
    const commands = [];
    const db = { command: async (command) => { commands.push(command); return { ok: 1 }; } };
    await applyTtlChange({ db });
    assert.deepEqual(commands, [{ collMod: 'serverchecks', expireAfterSeconds: DAYS_30 }]);
});
