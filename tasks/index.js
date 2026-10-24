// tasks/index.js - Cron Jobs (System Time)

import dotenv from 'dotenv';
dotenv.config();

import cron from 'node-cron';
import logger from '../utils/logger.js';
import istDataRetention from './dataRetention.js'; // You might want to rename this file too eventually
import smartCheckServers from './checkServers.js';
import jobQueue from '../utils/jobQueue.js';
import CronJob from '../models/CronJob.js';
import { resolveRetentionMode, retentionJobName } from '../utils/retentionMode.js';
import { startSchedulerWatchdog } from './schedulerWatchdog.js';

const retention = resolveRetentionMode(process.env.DATA_RETENTION_MODE);

// CONFIGURATION
const CONFIG = {
    // 'selective' unless told otherwise: it only removes checks older than CHECK_DATA_RETENTION_DAYS.
    // (The old default, 'aggressive', deleted every check each midnight, so history never survived a day.)
    DATA_RETENTION_MODE: retention.mode,

    // MIDNIGHT CRON (Runs at 00:00 system time)
    MIDNIGHT_CRON: '0 0 * * *',

    // Peak hours (server time)
    PEAK_HOURS: {
        start: parseInt(process.env.PEAK_HOURS_START) || 9,
        end: parseInt(process.env.PEAK_HOURS_END) || 18
    },

    SMART_MONITORING_ENABLED: process.env.SMART_MONITORING_ENABLED === 'true'
};

let watchdog = null;

/** 'ok' | 'stalled' | 'starting' (cron jobs not initialised yet). Shown by /health. */
export const getSchedulerStatus = () => watchdog?.status() ?? 'starting';

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
            logger.warn(`DATA_RETENTION_MODE="${process.env.DATA_RETENTION_MODE}" is not a known mode (selective, aggressive, emergency); using selective`);
        }

        // Initialize job queue with all tasks. A scheduling cycle only queues work and normally takes well under a
        // second, so 2 minutes means it is stuck (usually waiting on Redis or the database) and the next cycle
        // must not be blocked by it. Cleanup jobs legitimately take longer.
        jobQueue.add('smartCheckServers', smartCheckServers.checkAllServersIntelligently, 1, { timeoutMs: 2 * 60 * 1000 });
        jobQueue.add('aggressiveDataRetention', istDataRetention.runAggressiveDataRetention, 2, { timeoutMs: 30 * 60 * 1000 });
        jobQueue.add('selectiveDataRetention', istDataRetention.runSelectiveDataRetention, 2, { timeoutMs: 30 * 60 * 1000 });
        jobQueue.add('emergencyCleanup', istDataRetention.runEmergencyCleanup, 3, { timeoutMs: 30 * 60 * 1000 });

        // Log system info
        await logSystemInfo();

        // Start monitoring based on configuration
        if (CONFIG.SMART_MONITORING_ENABLED) {
            startAdaptiveMonitoring();
        } else {
            startBasicMonitoring();
        }

        // Midnight cleanup
        startMidnightCleanup();

        // Health monitoring
        startHealthMonitoring();

        // Notice (and recover from) a scheduler that has stopped finishing cycles
        watchdog = startSchedulerWatchdog({ queue: jobQueue });

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
        const jobName = getDataRetentionJobName();

        const cronJobRecord = createCronJob(jobName);

        try {
            await cronJobRecord.save();
        } catch (saveError) {
            logger.error(`Failed to save cron job record: ${saveError.message}`);
            // Continue execution even if logging fails
        }

        try {
            logger.info(`💀 Starting MIDNIGHT CLEANUP at ${new Date().toISOString()}`);
            logger.info(`🎯 Cleanup mode: ${CONFIG.DATA_RETENTION_MODE.toUpperCase()}`);

            const result = await jobQueue.execute(jobName);

            if (result === false) {
                logger.info('Midnight cleanup already running, skipping');
                cronJobRecord.status = 'skipped';
            } else {
                const duration = Date.now() - cronJobRecord.startedAt.getTime();
                logger.info('✅ MIDNIGHT CLEANUP completed successfully!', {
                    ...result,
                    duration,
                    mode: CONFIG.DATA_RETENTION_MODE
                });

                cronJobRecord.status = 'completed';
                cronJobRecord.result = {
                    ...result,
                    duration,
                    mode: CONFIG.DATA_RETENTION_MODE
                };

                // Log space savings if available
                if (result.spaceSavedMB) {
                    logger.info(`💾 Space saved: ${result.spaceSavedMB} MB`);
                }
            }

        } catch (error) {
            logger.error(`💥 MIDNIGHT CLEANUP ERROR: ${error.message}`);
            cronJobRecord.status = 'failed';
            cronJobRecord.error = error.message;

            // A failed cleanup used to trigger the 'emergency' one automatically, which deletes ALL history:
            // a passing database error at midnight wiped everything. Retention failing is only a reason to tell
            // a human; the TTL index on ServerCheck still bounds how much is kept, and tonight's run tries again.
            logger.error('Retention cleanup failed and nothing was deleted as a fallback. Set DATA_RETENTION_MODE=emergency and restart only if you really want to clear everything.');

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

    logger.info(`🕛 Midnight cleanup scheduled for 00:00 daily (system time, ${CONFIG.DATA_RETENTION_MODE} mode)`);
};

/**
 * Adaptive monitoring based on server time of day
 */
const startAdaptiveMonitoring = () => {
    logger.info('🧠 Starting ADAPTIVE monitoring system...');

    // Run every minute
    cron.schedule('* * * * *', async () => {
        const now = new Date();
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();

        // Determine current period based on hours
        let interval;
        if (currentHour >= CONFIG.PEAK_HOURS.start &&
            currentHour < CONFIG.PEAK_HOURS.end) {
            interval = 'peak';
        } else if (currentHour >= 22 || currentHour < 6) {
            interval = 'quiet';
        } else {
            interval = 'normal';
        }

        // Run every minute - logic in checkServers.js handles the filtering
        await executeSmartMonitoring(interval);
    });
};

/**
 * Basic monitoring - fallback when smart monitoring is disabled
 */
const startBasicMonitoring = () => {
    logger.info('⚡ Starting BASIC monitoring system (every 3 minutes)...');

    cron.schedule('*/3 * * * *', async () => {
        await executeSmartMonitoring('basic');
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

                // A large database is a reason to tell a human, not to delete every customer's history on a timer.
                // Run the 'emergency' retention mode by hand (DATA_RETENTION_MODE) if it really is needed.
                if (healthStats.dbSizeMB > 1000) {
                    logger.error('🚨 Database size is critical (>1 GB). Free space or change DATA_RETENTION_MODE; nothing was deleted automatically.');
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
 * Determine if we should run a check based on adaptive schedule
 */
const shouldRunAdaptiveCheck = (interval, currentMinute) => {
    switch (interval) {
        case 'peak':
            return currentMinute % 2 === 0; // Every 2 minutes during peak hours
        case 'normal':
            return currentMinute % 3 === 0; // Every 3 minutes during normal hours
        case 'quiet':
            return currentMinute % 5 === 0; // Every 5 minutes during quiet hours
        default:
            return currentMinute % 3 === 0;
    }
};

/**
 * Execute smart monitoring
 */
const executeSmartMonitoring = async (interval) => {
    const jobName = 'smartCheckServers';

    // Runs every minute: a database row per run (written twice) was 2,880 writes a day for nothing.
    // Only failures are recorded; normal runs are in the log.
    try {
        if (interval !== 'basic') {
            logger.debug(`🔄 Smart monitoring (${interval} mode)`);
        }

        const result = await jobQueue.execute(jobName);

        if (result && (result.total > 0 || result.error)) {
            logger.info(`✅ Monitoring (${interval}) dispatched ${result.dispatched}/${result.total} checks`, result.error ? { error: result.error } : undefined);
        }
    } catch (error) {
        logger.error(`❌ Monitoring error (${interval}): ${error.message}`);
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
        const dbStats = await istDataRetention.getCleanupRecommendations();
        health.dbSizeMB = dbStats.current.totalSizeMB || 0;

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
 * Get the appropriate data retention job name based on configuration
 */
const getDataRetentionJobName = () => retentionJobName(CONFIG.DATA_RETENTION_MODE);

/**
 * Log system information on startup
 */
const logSystemInfo = async () => {
    try {
        logger.info('🚀 Monitoring System Started', {
            time: new Date().toISOString(),
            dataRetentionMode: CONFIG.DATA_RETENTION_MODE,
            smartMonitoring: CONFIG.SMART_MONITORING_ENABLED,
            peakHours: `${CONFIG.PEAK_HOURS.start}:00 - ${CONFIG.PEAK_HOURS.end}:00`,
            midnightCleanup: '00:00 daily (system time)',
            nodeVersion: process.version,
            platform: process.platform
        });

    } catch (error) {
        logger.error(`Error logging system info: ${error.message}`);
    }
};

/**
 * Log cleanup recommendations
 */
const logCleanupRecommendations = async () => {
    try {
        const recommendations = await istDataRetention.getCleanupRecommendations();

        logger.info('📊 Current Data Status:', {
            serverChecks: recommendations.current.serverChecks,
            cronJobs: recommendations.current.cronJobs,
            databaseSize: `${recommendations.current.totalSizeMB} MB`,
            recommendedMode: recommendations.recommendation,
            currentMode: CONFIG.DATA_RETENTION_MODE,
            reasoning: recommendations.reasoning
        });

        if (recommendations.recommendation !== CONFIG.DATA_RETENTION_MODE) {
            logger.warn(`💡 Recommendation: Consider switching to '${recommendations.recommendation}' mode`);
            logger.warn(`Reason: ${recommendations.reasoning}`);
        }

    } catch (error) {
        logger.error(`Error getting cleanup recommendations: ${error.message}`);
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