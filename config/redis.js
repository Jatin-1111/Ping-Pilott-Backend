import { Redis } from 'ioredis';
import logger from '../utils/logger.js';

// Configuration for Redis connection
const redisConfig = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    // BullMQ requires maxRetriesPerRequest to be null
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
    }
};

// Create a singleton connection instance
export const redisConnection = new Redis(process.env.REDIS_URL || redisConfig);

redisConnection.on('connect', () => {
    logger.info('🔌 Redis connection established successfully');
});

redisConnection.on('error', (err) => {
    logger.error('❌ Redis connection error:', err);
});

export default redisConnection;
