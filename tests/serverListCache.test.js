// Run with: npm test
// A user's cached server lists live under a per-user version, so invalidating is one command (it used to be a SCAN over every
// key in Redis) and the number of keys cannot be inflated by adding junk query parameters. No Redis: a tiny fake.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerListCache, normalizeServerListQuery } from '../utils/serverListCache.js';

function fakeRedis() {
    const store = new Map();
    const commands = [];
    const run = (name, ...args) => commands.push([name, ...args]);
    return {
        commands,
        store,
        async get(k) { run('get', k); return store.get(k) ?? null; },
        multi() {
            const queued = [];
            const chain = {
                incr(k) { queued.push(() => { run('incr', k); store.set(k, String((Number(store.get(k)) || 0) + 1)); }); return chain; },
                expire(k, s) { queued.push(() => run('expire', k, s)); return chain; },
                async exec() { queued.forEach((fn) => fn()); return []; }
            };
            return chain;
        }
    };
}
const passThrough = (promise) => promise;

test('the key carries the user, their version and a digest of the normalised query', async () => {
    const cache = createServerListCache({ redis: fakeRedis(), withTimeout: passThrough });
    const key = await cache.key('u1', { status: 'down', page: '2' });
    assert.match(key, /^api:servers:u1:v0:[0-9a-f]{16}$/);
});

test('invalidating moves the user to a new key with one write, and nothing is scanned', async () => {
    const redis = fakeRedis();
    const cache = createServerListCache({ redis, withTimeout: passThrough });
    const before = await cache.key('u1', { status: 'down' });
    await cache.invalidate('u1');
    const after = await cache.key('u1', { status: 'down' });
    assert.notEqual(before, after);
    assert.match(after, /:v1:/);
    assert.ok(!redis.commands.some(([name]) => /scan|keys|del/i.test(name)));
    assert.deepEqual(redis.commands.filter(([name]) => name === 'incr').length, 1);
});

test('the version key expires far later than any list entry, so it cannot revive an old entry', async () => {
    const redis = fakeRedis();
    const cache = createServerListCache({ redis, withTimeout: passThrough });
    await cache.invalidate('u1');
    const [, , seconds] = redis.commands.find(([name]) => name === 'expire');
    assert.ok(seconds >= 60 * 60, `ttl ${seconds}s`);
});

test("one user's change does not touch another user's keys", async () => {
    const cache = createServerListCache({ redis: fakeRedis(), withTimeout: passThrough });
    const otherBefore = await cache.key('u2', {});
    await cache.invalidate('u1');
    assert.equal(await cache.key('u2', {}), otherBefore);
});

test('the same query always gives the same key, whatever the parameter order or search case', async () => {
    const cache = createServerListCache({ redis: fakeRedis(), withTimeout: passThrough });
    const a = await cache.key('u1', { status: 'up', page: '1', search: ' Shop ' });
    const b = await cache.key('u1', { search: 'shop', page: '1', status: 'up' });
    assert.equal(a, b);
});

test('junk query parameters cannot create new keys', async () => {
    const cache = createServerListCache({ redis: fakeRedis(), withTimeout: passThrough });
    const plain = await cache.key('u1', { status: 'up' });
    for (let i = 0; i < 50; i++) assert.equal(await cache.key('u1', { status: 'up', [`junk${i}`]: String(i) }), plain);
});

test('non-string values (arrays and objects from ?a[]=1 or ?a[b]=1) are ignored', () => {
    assert.equal(normalizeServerListQuery({ search: { a: '1' }, status: ['up', 'down'], page: '3' }), 'page=3');
    assert.equal(normalizeServerListQuery({}), '');
    assert.equal(normalizeServerListQuery(), '');
});

test('when Redis does not answer there is no key, so the cache is skipped instead of failing the request', async () => {
    const broken = { async get() { throw new Error('timed out'); } };
    const cache = createServerListCache({ redis: broken, withTimeout: passThrough });
    assert.equal(await cache.key('u1', {}), null);
});

test('a failed invalidation is reported to the caller (cacheManager logs it)', async () => {
    const broken = { multi() { throw new Error('connection lost'); } };
    const cache = createServerListCache({ redis: broken, withTimeout: passThrough });
    await assert.rejects(cache.invalidate('u1'), /connection lost/);
});
