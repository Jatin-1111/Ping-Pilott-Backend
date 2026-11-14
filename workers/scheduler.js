// workers/scheduler.js - the scheduler as its own process
//
//   npm run scheduler          (docker-compose.yml and ecosystem.config.cjs run it, with RUN_SCHEDULER=false on the API)
//
// The cron jobs (the check scheduler every minute, midnight clean-up, alert reconciler, trial pause, host roll-ups) have to
// run ONCE, not once per API instance. They used to start inside the API process, so the API could not be run as more than one
// instance without every job running several times. Run exactly one of these.
//
// It writes a heartbeat (role 'scheduler') while its own watchdog says the scheduler is finishing cycles. The API reads it, so
// /health/monitoring says no-scheduler when this process is gone or stuck.

import './loadEnv.js';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { redisConnection } from '../config/redis.js';
import { initCronJobs, getSchedulerStatus } from '../tasks/index.js';
import { startWorkerHeartbeat } from '../utils/workerHealth.js';
import logger from '../utils/logger.js';

await connectDB();
await initCronJobs();

// Beat only while the scheduler is healthy: a stuck scheduler must look absent, not alive
const heartbeat = startWorkerHeartbeat({
    redis: redisConnection,
    role: 'scheduler',
    isRunning: () => getSchedulerStatus() !== 'stalled'
});
logger.info('Scheduler process running');

let closing = false;
async function shutdown(signal) {
    if (closing) return;
    closing = true;
    logger.info(`${signal} received: stopping the scheduler process`);
    const forced = setTimeout(() => process.exit(1), 15000);
    forced.unref?.();
    try {
        await heartbeat.stop();
        await redisConnection.quit();
        await mongoose.connection.close();
        process.exit(0);
    } catch (error) {
        logger.error(`Error while stopping the scheduler process: ${error.message}`);
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// A rejected promise nobody handled is a bug to fix, but it is not a reason to stop scheduling (as in the API)
process.on('unhandledRejection', (err) => logger.error(`UNHANDLED REJECTION: ${err?.stack || err}`));
process.on('uncaughtException', (err) => {
    logger.error(`UNCAUGHT EXCEPTION: ${err?.stack || err}`);
    shutdown('UNCAUGHT_EXCEPTION');
});
