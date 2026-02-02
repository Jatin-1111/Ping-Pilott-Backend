import './loadEnv.js';
import { Worker } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import { checkServerStatus } from '../services/monitoringService.js';
import Server from '../models/Server.js';
import ServerCheck from '../models/ServerCheck.js';
import { addAlertToQueue } from '../queues/alertQueue.js';
import logger from '../utils/logger.js';
import mongoose from 'mongoose';

const QUEUE_NAME = 'monitor-server-queue';

// Batch operation buffers
const updateBatch = [];
const checkBatch = [];
let batchTimer = null;
const BATCH_SIZE = 100;
const BATCH_TIMEOUT = 5000;

async function executeBatch() {
    if (updateBatch.length === 0 && checkBatch.length === 0) return;

    const updateCount = updateBatch.length;
    const checkCount = checkBatch.length;

    try {
        logger.debug(`Executing batch: ${updateCount} updates, ${checkCount} checks`);
        await Promise.all([
            updateBatch.length > 0 ? Server.bulkWrite(updateBatch) : Promise.resolve(),
            checkBatch.length > 0 ? ServerCheck.insertMany(checkBatch, { ordered: false }) : Promise.resolve()
        ]);
        logger.debug(`Batch executed: ${updateCount} updates, ${checkCount} checks`);
    } catch (error) {
        logger.error('Batch execution failed:', error);
    } finally {
        updateBatch.length = 0;
        checkBatch.length = 0;
    }
}

async function addToBatch(updateOp, checkDoc) {
    updateBatch.push(updateOp);
    checkBatch.push(checkDoc);

    if (updateBatch.length >= BATCH_SIZE) {
        clearTimeout(batchTimer);
        await executeBatch();
    } else {
        clearTimeout(batchTimer);
        batchTimer = setTimeout(executeBatch, BATCH_TIMEOUT);
    }
}

export const monitorWorker = new Worker(QUEUE_NAME, async (job) => {
    const { serverId } = job.data;
    const startTime = Date.now();

    try {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGO_URI);
        }

        const server = await Server.findById(serverId)
            .select('name url type monitoring status lastChecked uploadedBy contactEmails contactPhones priority alertSettings')
            .lean();

        if (!server) {
            logger.warn(`Server ${serverId} not found, skipping check`);
            return;
        }

        const checkResult = await checkServerStatus(server);

        const checkDoc = {
            serverId: new mongoose.Types.ObjectId(serverId),
            status: checkResult.status,
            responseTime: checkResult.responseTime,
            error: checkResult.error,
            timestamp: new Date(),
            checkType: 'automated'
        };

        const updateData = {
            status: checkResult.status,
            responseTime: checkResult.responseTime,
            error: checkResult.error,
            lastChecked: new Date()
        };

        if (server.status !== checkResult.status) {
            updateData.lastStatusChange = new Date();
            const priority = server.priority === 'high' ? 'high' : 'normal';

            addAlertToQueue({
                serverId: server._id.toString(),
                oldStatus: server.status,
                newStatus: checkResult.status,
                checkResult,
                serverData: server
            }, priority).catch(err => {
                logger.error(`Failed to queue alert for ${server.name}: ${err.message}`);
            });
        }

        const updateOp = {
            updateOne: {
                filter: { _id: serverId },
                update: { $set: updateData }
            }
        };

        await addToBatch(updateOp, checkDoc);

        if (checkResult) {
            const updatePayload = {
                serverId: server._id,
                userId: server.uploadedBy,
                status: checkResult.status || 'unknown',
                latency: checkResult.responseTime,
                lastChecked: new Date()
            };
            redisConnection.publish('monitor-updates', JSON.stringify(updatePayload));
        }

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

monitorWorker.on('completed', (job) => { });

monitorWorker.on('failed', (job, err) => {
    logger.error(`Job ${job.id} has failed with ${err.message}`);
});

monitorWorker.on('closing', async () => {
    logger.info('Worker closing, executing remaining batch operations...');
    clearTimeout(batchTimer);
    await executeBatch();
});

logger.info(`🚀 Monitor Worker started - listening on queue: ${QUEUE_NAME}`);
