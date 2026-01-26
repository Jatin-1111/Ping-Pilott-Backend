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
        await checkServerStatus(server);

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
