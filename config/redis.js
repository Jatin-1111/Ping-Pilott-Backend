import { Redis } from 'ioredis';
import logger from '../utils/logger.js';
import { redisConnectionArgs } from './redisOptions.js';

// Create a singleton connection instance. The options (BullMQ needs maxRetriesPerRequest: null) apply whether Redis is
// configured with REDIS_URL or with host and port: see redisOptions.js.
export const redisConnection = new Redis(...redisConnectionArgs());

redisConnection.on('connect', () => {
    logger.info('🔌 Redis connection established successfully');
});

redisConnection.on('error', (err) => {
    logger.error('❌ Redis connection error:', err);
});

export default redisConnection;
