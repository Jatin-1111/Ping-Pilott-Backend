// utils/cacheManager.js - Redis cache management utilities

import { redisConnection } from '../config/redis.js';
import logger from './logger.js';
import { CACHE_STRATEGIES } from '../config/performance.js';

/**
 * Invalidate cache for a specific user's servers
 * @param {string} userId - User ID
 * @param {string} serverId - Optional specific server ID
 */
export async function invalidateServerCache(userId, serverId = null) {
    try {
        const pattern = serverId
            ? `api:servers:${userId}:*:${serverId}*`
            : `api:servers:${userId}:*`;

        const keys = await redisConnection.keys(pattern);
        if (keys.length > 0) {
            await redisConnection.del(...keys);
            logger.debug(`Invalidated ${keys.length} cache keys for user ${userId}`);
        }
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
        const pattern = `api:analytics:${userId}:*`;
        const keys = await redisConnection.keys(pattern);
        if (keys.length > 0) {
            await redisConnection.del(...keys);
            logger.debug(`Invalidated ${keys.length} analytics cache keys`);
        }
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
