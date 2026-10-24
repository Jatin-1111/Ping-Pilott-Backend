// tasks/index.js - Cron Jobs (System Time)

import dotenv from 'dotenv';
dotenv.config();

import cron from 'node-cron';
import logger from '../utils/logger.js';
import dataRetention from './dataRetention.js';
import smartCheckServers from './checkServers.js';
import jobQueue from '../utils/jobQueue.js';
import CronJob from '../models/CronJob.js';
import { resolveRetentionDays, legacyRetentionModeNotice } from '../utils/retention.js';
import { startSchedulerWatchdog } from './schedulerWatchdog.js';
import { CHECK_CRON } from '../utils/checkSchedule.js';
import PendingAlert from '../models/PendingAlert.js';
import { addAlertToQueue } from '../queues/alertQueue.js';
import { requeueUndelivered } from '../services/alertOutbox.js';
import { getPipelineHealth, recordDispatch } from '../services/pipelineHealth.js';
import { startHeartbeat } from './heartbeat.js';
import { redisConnection } from '../config/redis.js';
import Server from '../models/Server.js';
import Incident from '../models/Incident.js';
import User from '../models/User.js';
import { pauseExpiredTrials } from '../services/trialPause.js';
import { sendTrialEndedEmail } from '../services/emailService.js';
import { invalidateServerCache } from '../utils/cacheManager.js';

const retention = resolveRetentionDays(process.env.CHECK_DATA_RETENTION_DAYS);

// CONFIGURATION
const CONFIG = {
    // Checks older than this many days are deleted each midnight (utils/retention.js)
    RETENTION_DAYS: retention.days,

    // MIDNIGHT CRON (Runs at 00:00 system time)
    MIDNIGHT_CRON: '0 0 * * *'
};

let watchdog = null;

/** 'ok' | 'stalled' | 'starting' (cron jobs not initialised yet). Shown by /health. */
export const getSchedulerStatus = () => watchdog?.status() ?? 'starting';

const processStartedAt = Date.now();

/**
 * Is monitoring really happening: scheduler running, workers alive, checks finishing? { state, reasons }
 * Shown by /health/monitoring and used by the outside heartbeat.
 */
export const getPipelineState = () => getPipelineHealth({
    redis: redisConnection,
    schedulerStatus: getSchedulerStatus(),
    startedAt: processStartedAt
});

/**
 * Create CronJob record (system time)
 */
const createCronJob = (name) => {
    return new CronJob({
        name,
        status: 'running',
        startedAt: new Date()
    });
};

/**
 * Initialize cron jobs
 */
export const initCronJobs = async () => {
    try {
        logger.info('Initializing cron jobs...');

        if (!retention.recognized) {
            logger.warn(`CHECK_DATA_RETENTION_DAYS="${process.env.CHECK_DATA_RETENTION_DAYS}" must be a whole number of days from 1 to 30; using ${retention.days}`);
        }
        const legacyMode = legacyRetentionModeNotice(process.env.DATA_RETENTION_MODE);
        if (legacyMode) logger.warn(legacyMode);

        // Initialize job queue with all tasks. A scheduling cycle only queues work and normally takes well under a
        // second, so 2 minutes means it is stuck (usually waiting on Redis or the database) and the next cycle
        // must not be blocked by it. Cleanup jobs legitimately take longer.
        jobQueue.add('smartCheckServers', smartCheckServers.checkAllServersIntelligently, 1, { timeoutMs: 2 * 60 * 1000 });
        jobQueue.add('dataRetention', () => dataRetention.runDataRetention(CONFIG.RETENTION_DAYS), 2, { timeoutMs: 30 * 60 * 1000 });
        jobQueue.add('requeueAlerts', () => requeueUndelivered({ model: PendingAlert, queue: { add: addAlertToQueue } }), 1, { timeoutMs: 2 * 60 * 1000 });
        jobQueue.add('pauseExpiredTrials', runTrialPause, 2, { timeoutMs: 5 * 60 * 1000 });

        // Log system info
        await logSystemInfo();

        startMonitoring();

        // Alerts that were never queued, or whose job ran out of attempts, are queued again
        startAlertReconciler();

        // Free trials that ended: pause the server and tell the owner, once
        startTrialPause();

        // Midnight cleanup
        startMidnightCleanup();

        // Health monitoring
        startHealthMonitoring();

        // Notice (and recover from) a scheduler that has stopped finishing cycles
        watchdog = startSchedulerWatchdog({ queue: jobQueue });

        // Optional: ping an outside dead-man's-switch service while monitoring is healthy (HEARTBEAT_URL)
        startHeartbeat({ url: process.env.HEARTBEAT_URL, isHealthy: async () => (await getPipelineState()).state === 'ok' });

        logger.info('✅ All cron jobs initialized successfully');

    } catch (error) {
        logger.error(`❌ Error initializing cron jobs: ${error.message}`);
        throw error;
    }
};

/**
 * MIDNIGHT CLEANUP - Runs at 00:00 server time
 */
const startMidnightCleanup = () => {
    cron.schedule(CONFIG.MIDNIGHT_CRON, async () => {
        const jobName = 'dataRetention';

        const cronJobRecord = createCronJob(jobName);

        try {
            await cronJobRecord.save();
        } catch (saveError) {
            logger.error(`Failed to save cron job record: ${saveError.message}`);
            // Continue execution even if logging fails
        }

        try {
            logger.info(`Starting midnight clean-up at ${new Date().toISOString()} (keeping ${CONFIG.RETENTION_DAYS} days of checks)`);

            const result = await jobQueue.execute(jobName);

            if (result === false) {
                logger.info('Midnight cleanup already running, skipping');
                cronJobRecord.status = 'skipped';
            } else {
                const duration = Date.now() - cronJobRecord.startedAt.getTime();
                logger.info('Midnight clean-up completed', { ...result, duration });

                cronJobRecord.status = 'completed';
                cronJobRecord.result = { ...result, duration };
            }

        } catch (error) {
            logger.error(`💥 MIDNIGHT CLEANUP ERROR: ${error.message}`);
            cronJobRecord.status = 'failed';
            cronJobRecord.error = error.message;

            // A failed clean-up deletes nothing as a fallback. It is only a reason to tell a human: the TTL index on
            // ServerCheck still bounds how much is kept, and tonight's run tries again. If it keeps failing, run
            // scripts/checkRetention.js to see the state of the collection.
            logger.error('Retention clean-up failed and nothing was deleted as a fallback; it will be tried again tomorrow night.');

        } finally {
            cronJobRecord.completedAt = new Date();

            // Try to save with retry
            let saveAttempts = 0;
            const maxAttempts = 3;

            while (saveAttempts < maxAttempts) {
                try {
                    await cronJobRecord.save();
                    break; // Success, exit loop
                } catch (dbError) {
                    saveAttempts++;
                    logger.error(`Database error saving midnight cleanup job (attempt ${saveAttempts}/${maxAttempts}): ${dbError.message}`);

                    if (saveAttempts < maxAttempts) {
                        // Wait before retry
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
            }
        }
    });

    logger.info(`Midnight clean-up scheduled for 00:00 daily (system time, keeping ${CONFIG.RETENTION_DAYS} days of checks)`);
};

/**
 * Start the check scheduler. It wakes up every minute; which servers are due is decided in checkServers.js from each
 * server's own frequency, so a 1-minute monitor is checked every minute whatever else is configured.
 */
const startMonitoring = () => {
    logger.info('Starting the check scheduler (every minute)');

    cron.schedule(CHECK_CRON, runCheckCycle);
};

/** Pause servers whose free trial ended and email their owners (see services/trialPause.js) */
const runTrialPause = () => pauseExpiredTrials({
    servers: Server,
    incidents: Incident,
    users: User,
    sendNotice: sendTrialEndedEmail,
    // Open dashboards and the cached server list should show the new status at once
    onPaused: async (server) => {
        await invalidateServerCache(String(server.uploadedBy));
        redisConnection.publish('monitor-updates', JSON.stringify({
            serverId: server._id,
            userId: server.uploadedBy,
            status: 'unknown',
            latency: null,
            error: null,
            lastChecked: server.lastChecked
        })).catch(() => {});
    }
});

const startTrialPause = () => {
    cron.schedule('*/5 * * * *', async () => {
        try {
            await jobQueue.execute('pauseExpiredTrials');
        } catch (error) {
            logger.error(`Trial pause failed: ${error.message}`);
        }
    });
};

/**
 * Alert reconciler - every 5 minutes, queue the alerts that have not been delivered (see services/alertOutbox.js)
 */
const startAlertReconciler = () => {
    cron.schedule('*/5 * * * *', async () => {
        try {
            await jobQueue.execute('requeueAlerts');
        } catch (error) {
            logger.error(`Alert reconciler failed: ${error.message}`);
        }
    });
};

/**
 * Health monitoring - check system health every 15 minutes
 */
const startHealthMonitoring = () => {
    cron.schedule('*/15 * * * *', async () => {
        try {
            const healthStats = await getSystemHealth();

            if (healthStats.issues.length > 0) {
                logger.warn('⚠️ System health issues detected:', {
                    issues: healthStats.issues,
                    time: new Date().toISOString()
                });

                // A large database is a reason to tell a human, not to delete customers' history on a timer.
                if (healthStats.dbSizeMB > 1000) {
                    logger.error('🚨 Database size is critical (>1 GB). Free space or lower CHECK_DATA_RETENTION_DAYS; nothing was deleted automatically.');
                }
            } else {
                logger.debug('💚 System health OK', {
                    memory: `${Math.round(healthStats.memoryUsage.heapUsed / 1024 / 1024)}MB`,
                    db: `${healthStats.dbSizeMB}MB`
                });
            }

        } catch (error) {
            logger.error(`Health monitoring error: ${error.message}`);
        }
    });
};

/**
 * One scheduler cycle: queue a check for every server that is due
 */
const runCheckCycle = async () => {
    const jobName = 'smartCheckServers';

    // Runs every minute: a database row per run (written twice) was 2,880 writes a day for nothing.
    // Only failures are recorded; normal runs are in the log.
    try {
        // Throws when the cycle could not do its job (database or Redis down): see dispatchCycle.js
        const result = await jobQueue.execute(jobName);

        // /health compares this with the last finished check to see whether the workers are taking the jobs
        if (result?.dispatched > 0) recordDispatch();
    } catch (error) {
        logger.error(`❌ Monitoring error: ${error.message}`);
        try {
            await new CronJob({
                name: jobName,
                status: 'failed',
                startedAt: new Date(),
                completedAt: new Date(),
                error: error.message
            }).save();
        } catch (saveError) {
            logger.error(`Failed to save monitoring failure record: ${saveError.message}`);
        }
    }
};

/**
 * Get system health statistics
 */
const getSystemHealth = async () => {
    const health = {
        issues: [],
        activeJobs: 0,
        dbSizeMB: 0,
        memoryUsage: process.memoryUsage(),
        time: new Date().toISOString()
    };

    try {
        // Check recent job failures (last hour)
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const recentFailures = await CronJob.countDocuments({
            startedAt: { $gte: oneHourAgo },
            status: 'failed'
        });

        if (recentFailures > 5) {
            health.issues.push(`${recentFailures} job failures in the last hour`);
        }

        // Check memory usage
        const memoryUsageMB = health.memoryUsage.heapUsed / 1024 / 1024;
        if (memoryUsageMB > 500) {
            health.issues.push(`High memory usage: ${memoryUsageMB.toFixed(2)} MB`);
        }

        // Check database size
        health.dbSizeMB = await dataRetention.getDatabaseSizeMB();

        if (health.dbSizeMB > 500) {
            health.issues.push(`Large database size: ${health.dbSizeMB} MB`);
        }

        // Check running jobs
        health.activeJobs = jobQueue.getRunningJobs().length;
        if (health.activeJobs > 5) {
            health.issues.push(`Too many concurrent jobs: ${health.activeJobs}`);
        }

    } catch (error) {
        health.issues.push(`Health check error: ${error.message}`);
    }

    return health;
};

/**
 * Log system information on startup
 */
const logSystemInfo = async () => {
    try {
        logger.info('🚀 Monitoring System Started', {
            time: new Date().toISOString(),
            retentionDays: CONFIG.RETENTION_DAYS,
            midnightCleanup: '00:00 daily (system time)',
            nodeVersion: process.version,
            platform: process.platform
        });

    } catch (error) {
        logger.error(`Error logging system info: ${error.message}`);
    }
};

/**
 * Graceful shutdown handler
 */
const gracefulShutdown = async () => {
    logger.info('🛑 Graceful shutdown initiated...', {
        time: new Date().toISOString()
    });

    try {
        jobQueue.stop();

        const runningJobs = jobQueue.getRunningJobs();
        if (runningJobs.length > 0) {
            logger.info(`⏳ Waiting for ${runningJobs.length} jobs to complete...`);

            let attempts = 0;
            while (jobQueue.getRunningJobs().length > 0 && attempts < 30) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                attempts++;
            }
        }

        logger.info('✅ Graceful shutdown completed', {
            shutdownAt: new Date().toISOString()
        });

    } catch (error) {
        logger.error(`Error during graceful shutdown: ${error.message}`);
    }
};

// Register shutdown handlers
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

export default { initCronJobs, gracefulShutdown };