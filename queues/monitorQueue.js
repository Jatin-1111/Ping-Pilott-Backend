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
 * @param {Date} scheduledFor - The scheduler tick this check belongs to
 *   The job id includes the tick, so dispatching the same server twice for one tick is a no-op.
 */
export const addCheckJob = async (server, scheduledFor = new Date()) => {
    try {
        const priorityScore = server.priority === 'high' ? 1 : server.priority === 'low' ? 3 : 2;
        const tick = new Date(scheduledFor).getTime();

        await monitorQueue.add('check-server', {
            serverId: server._id || server.id,
            url: server.url,
            name: server.name,
            scheduledFor: tick
        }, {
            priority: priorityScore, // BullMQ supports priority (lower number = higher priority)
            jobId: `check-${server._id}-${tick}`
        });

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
