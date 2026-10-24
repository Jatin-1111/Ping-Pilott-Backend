// utils/cacheManager.js - Redis cache management utilities

import { redisConnection } from '../config/redis.js';
import logger from './logger.js';
import { CACHE_STRATEGIES } from '../config/performance.js';

/**
 * Delete every key matching a pattern. Uses SCAN (incremental) instead of KEYS, which blocks Redis
 * while it walks the whole keyspace.
 */
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

/**
 * Invalidate the cached server lists of a user. Call it after anything that changes what that user's
 * list shows: a server added, edited, deleted, checked, or its status changing.
 * (Cache keys are `api:servers:<userId>:<query>`; the old pattern never matched them, and nothing called it,
 * so a server you had just added was missing from the list for up to 30 seconds.)
 * @param {string} userId - owner of the servers
 */
export async function invalidateServerCache(userId) {
    try {
        const removed = await deleteByPattern(`api:servers:${userId}:*`);
        if (removed > 0) logger.debug(`Invalidated ${removed} cache keys for user ${userId}`);
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
        const removed = await deleteByPattern(`api:analytics:${userId}:*`);
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
        const cachedData = await redisConnection.get(key);
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
        await redisConnection.set(key, JSON.stringify(data), 'EX', ttl);
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
