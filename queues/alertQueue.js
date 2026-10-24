// queues/alertQueue.js - Alert queue configuration

import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import logger from '../utils/logger.js';
import { ALERT_JOB_OPTIONS } from './alertJobOptions.js';
import { withTimeout } from '../utils/timeout.js';

const ADD_TIMEOUT_MS = 10_000;

/**
 * Dedicated queue for alert processing
 * Separates alerts from monitoring checks for better reliability
 */
export const alertQueue = new Queue('alerts', {
    connection: redisConnection,
    // Retries are slow on purpose and a PendingAlert row backs them: see queues/alertJobOptions.js
    defaultJobOptions: ALERT_JOB_OPTIONS
});

/**
 * Add alert to queue
 * @param {Object} alertData - { pendingId, serverId }: the PendingAlert row to deliver
 * @param {string} priority - Priority level: 'high', 'normal', 'low'
 * @param {string} [jobId] - Same id twice is one job, so queueing an alert again cannot send it twice
 */
export async function addAlertToQueue(alertData, priority = 'normal', jobId = `alert-${alertData.pendingId || alertData.serverId}-${Date.now()}`) {
    try {
        const priorityMap = {
            high: 1,
            normal: 5,
            low: 10
        };

        // Redis commands wait forever while the connection is down. Give up instead: the PendingAlert row is
        // already saved, so the reconciler queues the alert when Redis is back.
        const job = await withTimeout(alertQueue.add(
            'process-alert',
            alertData,
            {
                priority: priorityMap[priority] || 5,
                jobId
            }
        ), ADD_TIMEOUT_MS, 'Queueing an alert');

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
