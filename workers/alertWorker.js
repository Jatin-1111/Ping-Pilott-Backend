// workers/alertWorker.js - Dedicated worker for alert processing

import { Worker } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import logger from '../utils/logger.js';
import { handleAlerts } from '../services/alertService.js';
import Server from '../models/Server.js';

/**
 * Dedicated worker for processing alerts
 * Separates alert processing from monitoring checks for better reliability
 */
const alertWorker = new Worker(
    'alerts',
    async (job) => {
        const { serverId, oldStatus, newStatus, checkResult, serverData } = job.data;

        try {
            logger.info(`Processing alert for server ${serverId}: ${oldStatus} -> ${newStatus}`);

            // Fetch full server data if not provided
            let server = serverData;
            if (!server) {
                server = await Server.findById(serverId)
                    .select('name url uploadedBy contactEmails contactPhones monitoring alertSettings')
                    .lean();

                if (!server) {
                    throw new Error(`Server ${serverId} not found`);
                }
            }

            // Process alerts
            await handleAlerts(
                { ...server, _id: serverId, status: oldStatus },
                oldStatus,
                newStatus,
                checkResult
            );

            logger.info(`Alert processed successfully for server ${serverId}`);
            return { success: true, serverId };

        } catch (error) {
            logger.error(`Error processing alert for server ${serverId}:`, error);
            throw error; // Will trigger retry
        }
    },
    {
        connection: redisConnection,
        concurrency: 10, // Process 10 alerts concurrently
        limiter: {
            max: 50, // Max 50 alerts per second
            duration: 1000
        },
        settings: {
            backoffStrategy: (attemptsMade) => {
                // Exponential backoff: 2s, 4s, 8s
                return Math.min(Math.pow(2, attemptsMade) * 1000, 10000);
            }
        }
    }
);

// Event handlers
alertWorker.on('completed', (job) => {
    logger.debug(`Alert job ${job.id} completed for server ${job.data.serverId}`);
});

alertWorker.on('failed', (job, err) => {
    logger.error(`Alert job ${job?.id} failed for server ${job?.data?.serverId}:`, err.message);
});

alertWorker.on('error', (err) => {
    logger.error('Alert worker error:', err);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, closing alert worker...');
    await alertWorker.close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    logger.info('SIGINT received, closing alert worker...');
    await alertWorker.close();
    process.exit(0);
});

logger.info('✅ Alert worker started');

export default alertWorker;
