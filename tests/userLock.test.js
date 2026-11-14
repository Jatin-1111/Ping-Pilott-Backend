// Run with: npm test
// Creating a monitor is "look for a duplicate, count the user's servers, insert". Run in parallel, every request counted the
// same servers and passed (12 creates on a plan that allows 5). utils/userLock.js makes those steps one request at a time.
// No database: the fake model below behaves like MongoDB's atomic upsert on a unique _id.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocker, LockBusyError } from '../utils/userLock.js';

/** The part of the Lock model the locker uses. Each call is atomic, as one MongoDB operation is. */
function fakeLockModel() {
    const docs = new Map();
    const duplicate = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    return {
        docs,
        async updateOne(filter, update) {
            const held = docs.get(filter._id);
            if (held && !(held.expiresAt < filter.expiresAt.$lt)) throw duplicate(); // filter does not match -> upsert inserts -> duplicate _id
            docs.set(filter._id, { _id: filter._id, ...update.$set });
        },
        async deleteOne(filter) {
            const held = docs.get(filter._id);
            if (held && held.owner === filter.owner) docs.delete(filter._id);
        }
    };
}

/** A clock the test moves by hand; sleeping advances it and lets other tasks run */
function fakeClock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; }, sleep: async (ms) => { t += ms; await Promise.resolve(); } };
}

const lockerWith = (model, clock, extra = {}) => createLocker({ model, now: clock.now, sleep: clock.sleep, ...extra });

test('twelve concurrent creates on a plan of five leave exactly five servers', async () => {
    const model = fakeLockModel();
    const clock = fakeClock();
    const { withLock } = lockerWith(model, clock, { waitMs: 60_000 });

    const servers = [];
    const limit = 5;
    // the same three steps the route runs: look, count, insert, each one an await so requests can interleave
    const create = (i) => withLock('server-create:user-1', async () => {
        await Promise.resolve();
        if (servers.some((s) => s.url === `u${i}`)) return 'duplicate';
        await Promise.resolve();
        if (servers.length >= limit) return 'limit';
        await Promise.resolve();
        servers.push({ url: `u${i}` });
        return 'created';
    });

    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => create(i)));
    assert.equal(results.filter((r) => r === 'created').length, 5);
    assert.equal(results.filter((r) => r === 'limit').length, 7);
    assert.equal(servers.length, 5);
});

test('without the lock the same race lets every request through (the bug this fixes)', async () => {
    const servers = [];
    const limit = 5;
    const create = async (i) => {
        await Promise.resolve();
        const count = servers.length;
        await Promise.resolve();
        if (count >= limit) return 'limit';
        await Promise.resolve();
        servers.push({ url: `u${i}` });
        return 'created';
    };
    await Promise.all(Array.from({ length: 12 }, (_, i) => create(i)));
    assert.equal(servers.length, 12);
});

test('five concurrent creates of the same address leave one', async () => {
    const model = fakeLockModel();
    const clock = fakeClock();
    const { withLock } = lockerWith(model, clock, { waitMs: 60_000 });
    const servers = [];
    const create = () => withLock('server-create:user-1', async () => {
        await Promise.resolve();
        if (servers.some((s) => s.url === 'same')) return 'duplicate';
        await Promise.resolve();
        servers.push({ url: 'same' });
        return 'created';
    });
    const results = await Promise.all(Array.from({ length: 5 }, create));
    assert.deepEqual(results.sort(), ['created', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
});

test('only one holder is inside at a time', async () => {
    const model = fakeLockModel();
    const clock = fakeClock();
    const { withLock } = lockerWith(model, clock, { waitMs: 60_000 });
    let inside = 0;
    let most = 0;
    await Promise.all(Array.from({ length: 8 }, () => withLock('k', async () => {
        inside += 1;
        most = Math.max(most, inside);
        await Promise.resolve();
        await Promise.resolve();
        inside -= 1;
    })));
    assert.equal(most, 1);
});

test('different keys do not wait for each other', async () => {
    const model = fakeLockModel();
    const clock = fakeClock();
    const { withLock } = lockerWith(model, clock, { waitMs: 1000 });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const slow = withLock('server-create:user-1', () => gate);
    await Promise.resolve();
    // another user is not held up by user-1's lock
    assert.equal(await withLock('server-create:user-2', async () => 'done'), 'done');
    release();
    await slow;
});

test('the lock is released when the work throws', async () => {
    const model = fakeLockModel();
    const clock = fakeClock();
    const { withLock } = lockerWith(model, clock, { waitMs: 1000 });
    await assert.rejects(withLock('k', async () => { throw new Error('insert failed'); }), /insert failed/);
    assert.equal(model.docs.size, 0);
    assert.equal(await withLock('k', async () => 'again'), 'again');
});

test('gives up with LOCK_BUSY when the lock stays held past the wait', async () => {
    const model = fakeLockModel();
    const clock = fakeClock();
    const { withLock, acquire } = lockerWith(model, clock, { waitMs: 200, ttlMs: 60_000 });
    await acquire('k'); // held and never released
    await assert.rejects(withLock('k', async () => 'never'), (err) => {
        assert.ok(err instanceof LockBusyError);
        assert.equal(err.code, 'LOCK_BUSY');
        return true;
    });
});

test('a lock whose holder never released it is free again after its ttl', async () => {
    const model = fakeLockModel();
    const clock = fakeClock();
    const { withLock, acquire } = lockerWith(model, clock, { waitMs: 100, ttlMs: 5000 });
    await acquire('k'); // the holder "crashes" here
    clock.advance(5001);
    assert.equal(await withLock('k', async () => 'taken over'), 'taken over');
});

test('releasing does not delete a lock someone else took after ours expired', async () => {
    const model = fakeLockModel();
    const clock = fakeClock();
    const { acquire, release } = lockerWith(model, clock, { ttlMs: 1000 });
    const first = await acquire('k');
    clock.advance(1500);
    const second = await acquire('k'); // takes over the expired lock
    await release('k', first); // the first holder finishes late
    assert.equal(model.docs.get('k').owner, second);
});

test('errors other than "already held" are not swallowed', async () => {
    const clock = fakeClock();
    const broken = { async updateOne() { throw Object.assign(new Error('network down'), { code: 'ECONNRESET' }); }, async deleteOne() {} };
    const { withLock } = lockerWith(broken, clock);
    await assert.rejects(withLock('k', async () => 'x'), /network down/);
});
