import { Redis } from 'ioredis';
import logger from '../utils/logger.js';
import { redisConnectionArgs } from './redisOptions.js';
import { throttled, suppressedNote } from '../utils/logThrottle.js';

const ERROR_LOG_INTERVAL_MS = 30 * 1000;

// Create a singleton connection instance. The options (BullMQ needs maxRetriesPerRequest: null) apply whether Redis is
// configured with REDIS_URL or with host and port: see redisOptions.js.
export const redisConnection = new Redis(...redisConnectionArgs());

redisConnection.on('connect', () => {
    logger.info('🔌 Redis connection established successfully');
});

redisConnection.on('error', (err) => {
    throttled('redis-error', ERROR_LOG_INTERVAL_MS, (n) => {
        logger.error(`❌ Redis connection error${suppressedNote(n, ERROR_LOG_INTERVAL_MS)}:`, err);
    });
});

export default redisConnection;
