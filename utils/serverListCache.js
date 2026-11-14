// utils/serverListCache.js - cache keys for a user's server list, invalidated in one step
//
// The list of a user's servers is cached for 30 s per query. Invalidation used to delete `api:servers:<user>:*` with SCAN, which
// visits EVERY key in Redis (BullMQ's queues included) to find one user's few, on every status change and every edit. Now each
// user has a version number inside their keys: invalidating is a single INCR, and entries under the old version are never read
// again and expire on their own. It also closes a race: a list built just before a change and stored just after it landed
// under the old version, where nothing reads it, instead of being served as current.
//
// The key also used the raw query string, so every distinct query (?x=1, ?x=2, ...) made a new Redis key. It is now built from
// the few parameters the list understands, normalised.

import crypto from 'node:crypto';

export const SERVER_LIST_PARAMS = ['search', 'status', 'type', 'plan', 'page', 'limit', 'sortBy', 'sortDir', 'admin'];
const VERSION_TTL_SECONDS = 24 * 60 * 60; // far longer than any entry (30 s), so a forgotten version can never revive an old entry

/** The query reduced to what the list reads, in a fixed order, as one string */
export function normalizeServerListQuery(query = {}) {
    const parts = [];
    for (const name of SERVER_LIST_PARAMS) {
        const value = query[name];
        if (typeof value !== 'string' || value === '') continue; // arrays and objects (?a[]=1, ?a[b]=1) are not valid values
        parts.push(`${name}=${name === 'search' ? value.trim().toLowerCase() : value}`);
    }
    return parts.join('&');
}

/**
 * @param {Object} deps
 * @param {Object} deps.redis        ioredis-like: get, multi().incr().expire().exec()
 * @param {Function} deps.withTimeout  (promise, ms, label) -> promise; Redis commands wait for ever while it is down
 * @param {number} [deps.timeoutMs]
 */
export function createServerListCache({ redis, withTimeout, timeoutMs = 300 }) {
    const versionKey = (userId) => `api:servers:ver:${userId}`;

    /** The key to read and write this user's list under, or null when Redis does not answer (skip the cache then) */
    async function key(userId, query) {
        try {
            const version = (await withTimeout(redis.get(versionKey(userId)), timeoutMs, 'Reading the server list version')) || '0';
            const digest = crypto.createHash('sha1').update(normalizeServerListQuery(query)).digest('hex').slice(0, 16);
            return `api:servers:${userId}:v${version}:${digest}`;
        } catch {
            return null;
        }
    }

    /** Make every cached list of this user stale. One command, however many keys exist. */
    async function invalidate(userId) {
        const k = versionKey(userId);
        await withTimeout(redis.multi().incr(k).expire(k, VERSION_TTL_SECONDS).exec(), timeoutMs * 3, 'Invalidating the server list');
    }

    return { key, invalidate };
}

export default { createServerListCache, normalizeServerListQuery, SERVER_LIST_PARAMS };
