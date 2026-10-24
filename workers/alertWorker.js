// workers/alertWorker.js - Dedicated worker for alert processing

// Must stay first: SMTP and Redis settings come from .env
import './loadEnv.js';

import { Worker } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import logger from '../utils/logger.js';
import { handleAlerts } from '../services/alertService.js';
import Server from '../models/Server.js';
import AlertEvent from '../models/AlertEvent.js';
import mongoose from 'mongoose';

/**
 * Dedicated worker for processing alerts
 * Separates alert processing from monitoring checks for better reliability
 */
const alertWorker = new Worker(
    'alerts',
    async (job) => {
        const { serverId, oldStatus, newStatus, checkResult, serverData } = job.data;
        // Jobs queued before the worker started sending `alertType` still carry old/new status
        const alertType = job.data.alertType
            || (newStatus === 'down' ? 'server_down' : (oldStatus === 'down' && newStatus === 'up' ? 'server_recovery' : null));

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
            const delivered = await handleAlerts(
                { ...server, _id: serverId, status: oldStatus },
                alertType,
                checkResult
            );

            // Keep a record of what was actually delivered: it feeds the admin analytics.
            // A failure to record must never make the job fail and re-send the alert.
            if (delivered) {
                try {
                    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGO_URI);
                    await AlertEvent.create({ serverId, userId: server.uploadedBy, type: alertType });
                } catch (recordError) {
                    logger.error(`Could not record alert event for ${serverId}: ${recordError.message}`);
                }
            }

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

// Graceful shutdown. Only when this worker is its own process: embedded in the API (see index.js) the API
// handles shutdown and closes the worker itself.
if (!process.env.PP_WORKERS_EMBEDDED) {
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
}

logger.info('✅ Alert worker started');

export default alertWorker;
