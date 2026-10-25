// controllers/statusPageController.js - the status page endpoints wired to the real cache
//
// The logic is in statusPageHandlers.js, which takes the cache as a parameter so tests need no Redis.

import { redisConnection } from '../config/redis.js';
import { getCachedData, setCachedData } from '../utils/cacheManager.js';
import logger from '../utils/logger.js';
import { createStatusPageHandlers } from './statusPageHandlers.js';

// Redis commands wait for ever while it is unreachable, so a delete must not be awaited without a limit
const withLimit = (promise, ms = 300) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);

const cache = {
    get: getCachedData,
    set: setCachedData,
    del: async (key) => {
        try {
            await withLimit(redisConnection.del(key));
        } catch (error) {
            logger.error(`Could not clear cached status page: ${error.message}`);
        }
    }
};

export const {
    listStatusPages,
    checkSlug,
    createStatusPage,
    updateStatusPage,
    deleteStatusPage,
    getPublicStatus
} = createStatusPageHandlers({ cache });

export default { listStatusPages, checkSlug, createStatusPage, updateStatusPage, deleteStatusPage, getPublicStatus };
