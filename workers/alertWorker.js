// workers/alertWorker.js - Dedicated worker for alert processing

// Must stay first: SMTP and Redis settings come from .env
import './loadEnv.js';

import { Worker } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import logger from '../utils/logger.js';
import { handleAlerts, shouldSendAlert } from '../services/alertService.js';
import { ALERT_CHANNEL, buildAlertMessage, toAlertItem } from '../utils/alertFeed.js';
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

            // Email and webhook. This throws when the email fails, so the job retries before anything below runs
            // and a retry can never record (or push) the same alert twice.
            const alertServer = { ...server, _id: serverId, status: oldStatus };
            await handleAlerts(alertServer, alertType, checkResult);

            // Keep a record of every alert the user was told about: it is the feed behind the mobile app and
            // feeds the admin analytics. Whether to tell them is the user's own setting (alerts on, inside their
            // alert hours), so the app gets alerts even when no email or webhook is set up.
            // A failure to record or push must never make the job fail and re-send the email.
            if (alertType && shouldSendAlert(alertServer)) {
                try {
                    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGO_URI);
                    const event = await AlertEvent.create({
                        serverId,
                        userId: server.uploadedBy,
                        type: alertType,
                        serverName: server.name,
                        serverUrl: server.url,
                        message: buildAlertMessage(alertType, checkResult, server)
                    });

                    // The API process owns the sockets, so hand the alert over through Redis
                    if (server.uploadedBy) {
                        await redisConnection.publish(
                            ALERT_CHANNEL,
                            JSON.stringify({ userId: String(server.uploadedBy), alert: toAlertItem(event) })
                        );
                    }
                } catch (recordError) {
                    logger.error(`Could not record or push alert event for ${serverId}: ${recordError.message}`);
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
