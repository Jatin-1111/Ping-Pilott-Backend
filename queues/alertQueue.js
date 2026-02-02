// queues/alertQueue.js - Alert queue configuration

import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import logger from '../utils/logger.js';

/**
 * Dedicated queue for alert processing
 * Separates alerts from monitoring checks for better reliability
 */
export const alertQueue = new Queue('alerts', {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3, // Retry failed alerts up to 3 times
        backoff: {
            type: 'exponential',
            delay: 2000 // Start with 2 second delay
        },
        removeOnComplete: {
            age: 3600, // Keep completed jobs for 1 hour
            count: 1000 // Keep last 1000 completed jobs
        },
        removeOnFail: {
            age: 86400 // Keep failed jobs for 24 hours
        }
    }
});

/**
 * Add alert to queue
 * @param {Object} alertData - Alert data
 * @param {string} alertData.serverId - Server ID
 * @param {string} alertData.oldStatus - Previous status
 * @param {string} alertData.newStatus - New status
 * @param {Object} alertData.checkResult - Check result data
 * @param {Object} alertData.serverData - Optional server data to avoid DB lookup
 * @param {string} priority - Priority level: 'high', 'normal', 'low'
 */
export async function addAlertToQueue(alertData, priority = 'normal') {
    try {
        const priorityMap = {
            high: 1,
            normal: 5,
            low: 10
        };

        const job = await alertQueue.add(
            'process-alert',
            alertData,
            {
                priority: priorityMap[priority] || 5,
                jobId: `alert-${alertData.serverId}-${Date.now()}` // Unique job ID
            }
        );

        logger.debug(`Alert queued for server ${alertData.serverId} with priority ${priority}`);
        return job;

    } catch (error) {
        logger.error(`Failed to queue alert for server ${alertData.serverId}:`, error);
        throw error;
    }
}

/**
 * Get queue statistics
 */
export async function getAlertQueueStats() {
    try {
        const [waiting, active, completed, failed, delayed] = await Promise.all([
            alertQueue.getWaitingCount(),
            alertQueue.getActiveCount(),
            alertQueue.getCompletedCount(),
            alertQueue.getFailedCount(),
            alertQueue.getDelayedCount()
        ]);

        return {
            waiting,
            active,
            completed,
            failed,
            delayed,
            total: waiting + active + delayed
        };
    } catch (error) {
        logger.error('Failed to get alert queue stats:', error);
        return null;
    }
}

logger.info('✅ Alert queue initialized');

export default alertQueue;
