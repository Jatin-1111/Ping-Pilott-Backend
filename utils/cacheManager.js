// utils/cacheManager.js - Redis cache management utilities

import { redisConnection } from '../config/redis.js';
import logger from './logger.js';
import { CACHE_STRATEGIES } from '../config/performance.js';
import { createServerListCache } from './serverListCache.js';

/**
 * Delete every key matching a pattern. Uses SCAN (incremental) instead of KEYS, which blocks Redis
 * while it walks the whole keyspace.
 */
// The Redis connection queues commands forever while Redis is unreachable (the job queues need that), so a cache
// call must not be awaited without a limit: a slow or missing cache should cost one skipped lookup, not a hung request.
const CACHE_TIMEOUT_MS = 300;

function withTimeout(promise, ms = CACHE_TIMEOUT_MS) {
    let timer;
    const limit = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`cache call timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function deleteByPattern(pattern) {
    let removed = 0;
    const stream = redisConnection.scanStream({ match: pattern, count: 200 });
    for await (const keys of stream) {
        if (keys.length > 0) {
            await redisConnection.del(...keys);
            removed += keys.length;
        }
    }
    return removed;
}

// A user's cached server lists live under a per-user version number (utils/serverListCache.js): invalidating is one INCR
// instead of a SCAN over every key in Redis, which ran on every status change and every edit.
const serverListCache = createServerListCache({ redis: redisConnection, withTimeout, timeoutMs: CACHE_TIMEOUT_MS });

/** The key to cache this user's server list under, or null when Redis does not answer (then skip the cache) */
export const serverListCacheKey = (userId, query) => serverListCache.key(userId, query);

/**
 * Invalidate the cached server lists of a user. Call it after anything that changes what that user's
 * list shows: a server added, edited, deleted, checked, or its status changing.
 * @param {string} userId - owner of the servers
 */
export async function invalidateServerCache(userId) {
    try {
        await serverListCache.invalidate(userId);
    } catch (error) {
        logger.error(`Error invalidating cache: ${error.message}`);
    }
}

/**
 * Invalidate analytics cache
 * @param {string} userId - User ID
 */
export async function invalidateAnalyticsCache(userId) {
    try {
        const removed = await withTimeout(deleteByPattern(`api:analytics:${userId}:*`), 2000);
        if (removed > 0) logger.debug(`Invalidated ${removed} analytics cache keys`);
    } catch (error) {
        logger.error(`Error invalidating analytics cache: ${error.message}`);
    }
}

/**
 * Get cached data with automatic parsing
 * @param {string} key - Cache key
 * @returns {Object|null} Parsed data or null
 */
export async function getCachedData(key) {
    try {
        const cachedData = await withTimeout(redisConnection.get(key));
        if (cachedData) {
            return JSON.parse(cachedData);
        }
        return null;
    } catch (error) {
        logger.error(`Error getting cached data: ${error.message}`);
        return null;
    }
}

/**
 * Set cached data with automatic stringification
 * @param {string} key - Cache key
 * @param {Object} data - Data to cache
 * @param {number} ttl - Time to live in seconds
 */
export async function setCachedData(key, data, ttl = CACHE_STRATEGIES.serverList) {
    try {
        await withTimeout(redisConnection.set(key, JSON.stringify(data), 'EX', ttl));
    } catch (error) {
        logger.error(`Error setting cached data: ${error.message}`);
    }
}

/**
 * Request deduplication - prevents duplicate simultaneous requests
 */
const pendingRequests = new Map();

export async function dedupedFetch(key, fetchFn) {
    if (pendingRequests.has(key)) {
        logger.debug(`Deduplicating request for key: ${key}`);
        return pendingRequests.get(key);
    }

    const promise = fetchFn();
    pendingRequests.set(key, promise);

    try {
        const result = await promise;
        return result;
    } finally {
        pendingRequests.delete(key);
    }
}
