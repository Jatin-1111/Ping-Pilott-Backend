// workers/alertWorker.js - Dedicated worker for alert processing

// Must stay first: SMTP and Redis settings come from .env
import './loadEnv.js';

import { Worker } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import logger from '../utils/logger.js';
import { throttled, suppressedNote } from '../utils/logThrottle.js';
import { startWorkerHeartbeat } from '../utils/workerHealth.js';
import { maskCredentials } from '../utils/address.js';
import { sendAlertChannels } from '../services/alertService.js';
import { deliverAlert } from '../services/alertDelivery.js';
import { ALERT_CHANNEL, buildAlertMessage, toAlertItem } from '../utils/alertFeed.js';
import Server from '../models/Server.js';
import AlertEvent from '../models/AlertEvent.js';
import PendingAlert from '../models/PendingAlert.js';
import mongoose from 'mongoose';

const ensureMongo = async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGO_URI);
};

/**
 * Keep a record of every alert the user was told about: it is the feed behind the mobile app and feeds the admin
 * analytics. The app gets the alert even when no email or webhook is set up.
 * Throws only when the row could not be written; the live push is best effort, because the app catches up from the feed.
 */
const recordFeed = async (pending, server) => {
    const checkResult = pending.checkResult || {};
    const event = await AlertEvent.create({
        serverId: pending.serverId,
        userId: server.uploadedBy,
        type: pending.alertType,
        serverName: server.name,
        serverUrl: maskCredentials(server.url),
        message: buildAlertMessage(pending.alertType, checkResult, server),
        // Only a down alert has a failure to explain
        ...(pending.alertType === 'server_down' && checkResult.failureKind ? { failureKind: checkResult.failureKind } : {}),
        ...(pending.alertType === 'server_down' && Number.isInteger(checkResult.statusCode) ? { statusCode: checkResult.statusCode } : {})
    });

    // The API process owns the sockets, so hand the alert over through Redis
    if (server.uploadedBy) {
        try {
            await redisConnection.publish(
                ALERT_CHANNEL,
                JSON.stringify({ userId: String(server.uploadedBy), alert: toAlertItem(event) })
            );
        } catch (pushError) {
            logger.error(`Could not push alert event for ${pending.serverId}: ${pushError.message}`);
        }
    }
};

const deps = {
    findServer: (serverId) => Server.findById(serverId)
        .select('name url uploadedBy contactEmails contactPhones monitoring timezone priority')
        .lean(),
    saveProgress: async (pendingId, set) => {
        if (pendingId) await PendingAlert.updateOne({ _id: pendingId }, { $set: set });
    },
    recordFeed,
    sendChannels: sendAlertChannels
};

/** Jobs queued before alerts were kept in the database carry the alert itself. Deliver them once, without a row. */
const legacyPending = ({ serverId, alertType, oldStatus, newStatus, checkResult }) => ({
    _id: null,
    serverId,
    alertType: alertType || (newStatus === 'down' ? 'server_down' : (oldStatus === 'down' && newStatus === 'up' ? 'server_recovery' : null)),
    oldStatus,
    newStatus,
    checkResult,
    done: {}
});

/**
 * Dedicated worker for processing alerts
 * Separates alert processing from monitoring checks for better reliability
 */
const alertWorker = new Worker(
    'alerts',
    async (job) => {
        const { pendingId, serverId } = job.data;

        try {
            await ensureMongo();

            const pending = pendingId ? await PendingAlert.findById(pendingId).lean() : legacyPending(job.data);
            if (!pending || !pending.alertType) {
                logger.warn(`Alert job ${job.id} has nothing to deliver (alert ${pendingId || 'unknown'} not found)`);
                return { success: true, serverId };
            }
            if (pending.deliveredAt || pending.abandonedAt) return { success: true, serverId };

            logger.info(`Processing ${pending.alertType} alert for server ${pending.serverId}: ${pending.oldStatus} -> ${pending.newStatus}`);

            // Throws while any part is still undelivered, so the queue retries and only the missing parts are repeated
            await deliverAlert(pending, deps);

            logger.info(`Alert processed successfully for server ${pending.serverId}`);
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
        }
    }
);

// Event handlers
alertWorker.on('completed', (job) => {
    logger.debug(`Alert job ${job.id} completed for server ${job.data.serverId}`);
});

alertWorker.on('failed', (job, err) => {
    const attempts = job?.opts?.attempts ?? 1;
    const lastAttempt = job && job.attemptsMade >= attempts;
    logger.error(
        `Alert job ${job?.id} for server ${job?.data?.serverId} failed (attempt ${job?.attemptsMade}/${attempts})` +
        `${lastAttempt ? '; out of attempts, the alert stays pending and is queued again later' : ''}:`,
        err.message
    );
});

alertWorker.on('error', (err) => {
    throttled('alert-worker-error', 30 * 1000, (n) => {
        logger.error(`Alert worker error${suppressedNote(n, 30 * 1000)}:`, err);
    });
});

// Say "alive" every 15 s for /health and the container healthcheck; the key expires if this process stops
const heartbeat = startWorkerHeartbeat({ redis: redisConnection, role: 'alert', isRunning: () => alertWorker.isRunning() });
alertWorker.on('closing', () => { heartbeat.stop(); });

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
