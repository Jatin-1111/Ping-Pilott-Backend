import './loadEnv.js'; // Must be first to load ENV before other imports
import { Worker } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import { checkServerStatus } from '../services/monitoringService.js';
import Server from '../models/Server.js';
import ServerCheck from '../models/ServerCheck.js';
import { handleAlerts } from '../services/alertService.js';
import logger from '../utils/logger.js';
import mongoose from 'mongoose';

const QUEUE_NAME = 'monitor-server-queue';

// Create the worker
export const monitorWorker = new Worker(QUEUE_NAME, async (job) => {
    const { serverId } = job.data;
    const startTime = Date.now();

    try {
        // Ensure Database Connection (each worker process needs its own connection)
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGO_URI);
        }

        // Fetch fresh server data (optional, but safer to get latest config)
        // Or just pass necessary data via job. For robustness, specific check might need latest DB state.
        // For efficiency, we can assume job data is good enough? 
        // Let's fetch the server document to ensure we have the full mongoose model if checkServerStatus expects it.
        // checkServerStatus expects a Server document? Let's check service signature.

        // Optimization: checking service signature in next validation step. 
        // Assuming checkServerStatus takes a Server Document or ID.
        // If it takes a document, we must fetch it.

        const server = await Server.findById(serverId);

        if (!server) {
            logger.warn(`Server ${serverId} not found, skipping check`);
            return;
        }

        // Perform the check
        const checkResult = await checkServerStatus(server);

        // Create enhanced check history document
        const checkDoc = {
            serverId: new mongoose.Types.ObjectId(serverId),
            status: checkResult.status,
            responseTime: checkResult.responseTime,
            error: checkResult.error,
            timestamp: new Date(),
            checkType: 'automated'
        };

        // Prepare batch update data for Server
        const updateData = {
            status: checkResult.status,
            responseTime: checkResult.responseTime,
            error: checkResult.error,
            lastChecked: new Date()
        };

        // Handle Alerts (Async, don't block check completion)
        // Pass original server (with old status) and new status result
        handleAlerts(server, server.status, checkResult.status, checkResult).catch(err => {
            logger.error(`Error processing alerts for ${server.name}: ${err.message}`);
        });

        // Only update status change time if status actually changed
        if (server.status !== checkResult.status) {
            updateData.lastStatusChange = new Date();
        }

        // Execute database operations in parallel
        await Promise.all([
            Server.updateOne({ _id: serverId }, updateData),
            ServerCheck.create(checkDoc)
        ]);

        // Publish update to Redis for real-time WebSocket clients
        if (checkResult) {
            const updatePayload = {
                serverId: server._id,
                status: checkResult.status || 'unknown',
                latency: checkResult.responseTime,
                lastChecked: new Date()
            };

            redisConnection.publish('monitor-updates', JSON.stringify(updatePayload));
        }

        logger.debug(`Job ${job.id} (Check ${server.name}) processed in ${Date.now() - startTime}ms`);

    } catch (error) {
        logger.error(`Worker failed for job ${job.id}: ${error.message}`);
        throw error; // Let BullMQ handle retry
    }
}, {
    connection: redisConnection,
    concurrency: 50, // Process 50 checks safely in parallel per worker instance
    limiter: {
        max: 100, // Max 100 jobs
        duration: 1000 // per second (Rate limit checks if needed)
    }
});

monitorWorker.on('completed', (job) => {
    // logger.info(`Job ${job.id} completed!`);
});

monitorWorker.on('failed', (job, err) => {
    logger.error(`Job ${job.id} has failed with ${err.message}`);
});

logger.info(`🚀 Monitor Worker started - listening on queue: ${QUEUE_NAME}`);
