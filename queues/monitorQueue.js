import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import logger from '../utils/logger.js';

// Define the queue name
const QUEUE_NAME = 'monitor-server-queue';

// Create the queue instance
export const monitorQueue = new Queue(QUEUE_NAME, {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3, // Retry failed checks 3 times
        backoff: {
            type: 'exponential',
            delay: 1000 // Start with 1s delay
        },
        removeOnComplete: true, // Auto-remove completed jobs to save memory
        removeOnFail: 50 // Keep last 50 failed jobs for debugging
    }
});

/**
 * Add a server check job to the queue
 * @param {Object} server - The server object (must contain _id)
 * @param {number} priority - Optional priority (default: 1)
 */
export const addCheckJob = async (server, priority = 1) => {
    try {
        const priorityScore = server.priority === 'high' ? 1 : server.priority === 'low' ? 3 : 2;

        await monitorQueue.add('check-server', {
            serverId: server._id || server.id,
            url: server.url,
            name: server.name
        }, {
            priority: priorityScore, // BullMQ supports priority (lower number = higher priority)
            jobId: `check-${server._id}-${Date.now()}` // Unique ID prevent duplicates in same millisecond
        });

        // logger.debug(`Added check job for ${server.name} to queue`);
        return true;
    } catch (error) {
        logger.error(`Failed to add job to queue: ${error.message}`);
        return false;
    }
};

// Handle queue errors
monitorQueue.on('error', (err) => {
    logger.error('Monitor Queue Error:', err);
});

export default monitorQueue;
