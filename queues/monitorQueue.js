import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import logger from '../utils/logger.js';
import { withTimeout } from '../utils/timeout.js';
import { checkJobOptions } from '../utils/checkSchedule.js';
import { throttled, suppressedNote } from '../utils/logThrottle.js';

// Define the queue name
const QUEUE_NAME = 'monitor-server-queue';

// How long to wait for Redis to accept one check before treating it as failed
const ADD_TIMEOUT_MS = 10_000;

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
 *   The job starts at the server's own offset into the minute (utils/checkSchedule.js), which spreads a crowded tick out.
 */
export const addCheckJob = async (server, scheduledFor = new Date()) => {
    try {
        const tick = new Date(scheduledFor).getTime();

        // Redis commands wait forever while the connection is down. Give up after a while instead: the server is then
        // not marked as dispatched, so the next scheduler cycle simply tries it again.
        await withTimeout(monitorQueue.add('check-server', {
            serverId: server._id || server.id,
            url: server.url,
            name: server.name,
            scheduledFor: tick
        }, checkJobOptions(server, tick)), ADD_TIMEOUT_MS, `Queueing a check for ${server.name || server._id}`);

        return true;
    } catch (error) {
        logger.error(`Failed to add job to queue: ${error.message}`);
        return false;
    }
};

// Handle queue errors
monitorQueue.on('error', (err) => {
    throttled('monitor-queue-error', 30 * 1000, (n) => {
        logger.error(`Monitor Queue Error${suppressedNote(n, 30 * 1000)}:`, err);
    });
});

export default monitorQueue;
