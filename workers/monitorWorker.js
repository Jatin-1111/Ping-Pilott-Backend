import './loadEnv.js';
import { Worker } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import { checkServerStatus } from '../services/monitoringService.js';
import Server from '../models/Server.js';
import ServerCheck from '../models/ServerCheck.js';
import { applyCheckResult } from '../services/checkRecorder.js';
import logger from '../utils/logger.js';
import mongoose from 'mongoose';

const QUEUE_NAME = 'monitor-server-queue';

// A server that was up and fails is checked once more before it is declared down, so one dropped
// request does not page anyone. Set DOWN_CONFIRM_DELAY_MS=0 to disable.
const CONFIRM_DELAY_MS = process.env.DOWN_CONFIRM_DELAY_MS !== undefined
    ? parseInt(process.env.DOWN_CONFIRM_DELAY_MS, 10)
    : 10000;

// A check job that has waited this long is out of date: the next scheduled check has already taken its place.
// Skipping them matters after the workers have been down for a while, when thousands of old jobs are waiting and
// running them all would hit the monitored sites in one burst and fill the history with checks stamped "now".
const STALE_JOB_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Check history is written in batches (it is append-only, so a late write is harmless).
// The server's own status is NOT batched: it must be written atomically, see below.
const checkBatch = [];
let batchTimer = null;
const BATCH_SIZE = 100;
const BATCH_TIMEOUT = 5000;

async function executeBatch() {
    if (checkBatch.length === 0) return;

    const docs = checkBatch.splice(0, checkBatch.length);
    try {
        await ServerCheck.insertMany(docs, { ordered: false });
    } catch (error) {
        logger.error(`Check history batch failed (${docs.length} checks): ${error.message}`);
    }
}

async function addToBatch(checkDoc) {
    checkBatch.push(checkDoc);
    clearTimeout(batchTimer);

    if (checkBatch.length >= BATCH_SIZE) {
        await executeBatch();
    } else {
        batchTimer = setTimeout(executeBatch, BATCH_TIMEOUT);
    }
}

export const monitorWorker = new Worker(QUEUE_NAME, async (job) => {
    const { serverId } = job.data;
    const startTime = Date.now();

    // scheduledFor is the scheduler tick; jobs queued by older versions only have the time they were added
    const queuedAt = job.data.scheduledFor || job.timestamp;
    if (queuedAt && startTime - queuedAt > STALE_JOB_MS) {
        logger.debug(`Skipping stale check job ${job.id} (queued ${Math.round((startTime - queuedAt) / 60000)} min ago)`);
        return;
    }

    try {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGO_URI);
        }

        const server = await Server.findById(serverId)
            .select('name url type timezone monitoring status lastChecked uploadedBy contactEmails contactPhones priority slowAlerted')
            .lean();

        if (!server) {
            logger.warn(`Server ${serverId} not found, skipping check`);
            return;
        }

        let checkResult = await checkServerStatus(server);

        // Confirm a first failure before acting on it
        if (checkResult.status === 'down' && server.status === 'up' && CONFIRM_DELAY_MS > 0) {
            await sleep(CONFIRM_DELAY_MS);
            checkResult = await checkServerStatus(server);
        }

        const { now } = await applyCheckResult(server, checkResult);

        await addToBatch({
            serverId: new mongoose.Types.ObjectId(serverId),
            status: checkResult.status,
            responseTime: checkResult.responseTime,
            error: checkResult.error,
            timestamp: now,
            checkType: 'automated'
        });

        logger.debug(`Job ${job.id} (Check ${server.name}) processed in ${Date.now() - startTime}ms`);

    } catch (error) {
        logger.error(`Worker failed for job ${job.id}: ${error.message}`);
        throw error;
    }
}, {
    connection: redisConnection,
    concurrency: 50,
    limiter: {
        max: 100,
        duration: 1000
    }
});

monitorWorker.on('completed', () => { });

monitorWorker.on('failed', (job, err) => {
    logger.error(`Job ${job?.id} has failed with ${err.message}`);
});

monitorWorker.on('error', (err) => {
    logger.error(`Monitor worker error: ${err.message}`);
});

monitorWorker.on('closing', async () => {
    logger.info('Worker closing, writing remaining check history...');
    clearTimeout(batchTimer);
    await executeBatch();
});

// Flush buffered history and stop taking jobs when the process is asked to stop
const shutdown = async (signal) => {
    logger.info(`${signal} received, closing monitor worker...`);
    try {
        await monitorWorker.close();
    } finally {
        process.exit(0);
    }
};
// As its own process this worker handles shutdown. Embedded in the API process (see index.js) the API does,
// and closes the worker itself, so two handlers do not race to exit.
if (!process.env.PP_WORKERS_EMBEDDED) {
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

logger.info(`🚀 Monitor Worker started - listening on queue: ${QUEUE_NAME}`);
