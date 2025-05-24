// tasks/index.js - UPDATED WITH MIDNIGHT CLEANUP 🕛
import dotenv from 'dotenv';
dotenv.config();

import cron from 'node-cron';
import logger from '../utils/logger.js';
import aggressiveDataRetention from './dataRetention.js';
import smartCheckServers from './checkServers.js'
import jobQueue from '../utils/jobQueue.js';
import CronJob from '../models/CronJob.js';
import moment from 'moment-timezone';

// Smart scheduling configuration
const SMART_CONFIG = {
    // Data retention mode - change this based on your needs
    DATA_RETENTION_MODE: process.env.DATA_RETENTION_MODE || 'aggressive', // 'aggressive', 'selective', or 'emergency'

    // Adaptive monitoring intervals
    CHECK_INTERVALS: {
        peak: '*/2 * * * *',      // Every 2 minutes during peak hours
        normal: '*/3 * * * *',    // Every 3 minutes during normal hours  
        quiet: '*/5 * * * *'      // Every 5 minutes during quiet hours
    },

    // Peak hours configuration
    PEAK_HOURS: {
        start: parseInt(process.env.PEAK_HOURS_START) || 9,  // 9 AM
        end: parseInt(process.env.PEAK_HOURS_END) || 18      // 6 PM
    },

    // Timezone for scheduling
    TIMEZONE: 'Asia/Kolkata',

    // Smart monitoring toggle
    SMART_MONITORING_ENABLED: process.env.SMART_MONITORING_ENABLED === 'true'
};

// Add this right after the SMART_CONFIG definition
console.log('🔍 DEBUG ENV VARS:', {
    SMART_MONITORING_ENABLED: process.env.SMART_MONITORING_ENABLED,
    NODE_ENV: process.env.NODE_ENV,
    envType: typeof process.env.SMART_MONITORING_ENABLED
});

/**
 * Initialize smart cron jobs with midnight cleanup
 */
export const initCronJobs = async () => {
    try {
        logger.info('🕛 Initializing SMART cron jobs with MIDNIGHT CLEANUP...');

        // Set consistent timezone
        process.env.TZ = 'UTC';
        moment.tz.setDefault('UTC');

        // Initialize job queue with all tasks
        jobQueue.add('smartCheckServers', smartCheckServers.checkAllServersIntelligently, 1);
        jobQueue.add('aggressiveDataRetention', aggressiveDataRetention.runAggressiveDataRetention, 2);
        jobQueue.add('selectiveDataRetention', aggressiveDataRetention.runSelectiveDataRetention, 2);
        jobQueue.add('emergencyCleanup', aggressiveDataRetention.runEmergencyCleanup, 3);

        // Log system info and recommendations
        await logSystemInfo();
        await logCleanupRecommendations();

        // Start smart monitoring
        if (SMART_CONFIG.SMART_MONITORING_ENABLED) {
            startAdaptiveMonitoring();
        } else {
            startBasicMonitoring();
        }

        // MIDNIGHT DATA CLEANUP - The main event! 🕛💀
        startMidnightCleanup();

        // Health monitoring
        startHealthMonitoring();

        logger.info('✅ All smart cron jobs with midnight cleanup initialized successfully');

    } catch (error) {
        logger.error(`❌ Error initializing smart cron jobs: ${error.message}`);
        throw error;
    }
};

/**
 * MIDNIGHT CLEANUP - Runs at exactly 00:00 IST every day
 */
const startMidnightCleanup = () => {
    // 18:30 UTC = 00:00 IST (midnight in India)
    cron.schedule('30 18 * * *', async () => {
        const jobName = getDataRetentionJobName();
        const startTime = new Date();

        const cronJobRecord = new CronJob({
            name: jobName,
            status: 'running',
            startedAt: startTime,
            timezone: SMART_CONFIG.TIMEZONE
        });

        try {
            await cronJobRecord.save();

            const midnightIST = moment().tz(SMART_CONFIG.TIMEZONE).format('YYYY-MM-DD HH:mm:ss');
            logger.info(`💀 Starting MIDNIGHT CLEANUP at ${midnightIST} IST`);
            logger.info(`🎯 Cleanup mode: ${SMART_CONFIG.DATA_RETENTION_MODE.toUpperCase()}`);

            const result = await jobQueue.execute(jobName);

            if (result === false) {
                logger.info('Midnight cleanup already running, skipping');
                cronJobRecord.status = 'skipped';
            } else {
                const duration = Date.now() - startTime.getTime();
                logger.info('✅ MIDNIGHT CLEANUP completed successfully!', {
                    ...result,
                    duration,
                    mode: SMART_CONFIG.DATA_RETENTION_MODE
                });

                cronJobRecord.status = 'completed';
                cronJobRecord.result = {
                    ...result,
                    duration,
                    mode: SMART_CONFIG.DATA_RETENTION_MODE,
                    cleanupTime: midnightIST
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

            // Try emergency cleanup if regular cleanup fails
            if (SMART_CONFIG.DATA_RETENTION_MODE !== 'emergency') {
                logger.warn('🚨 Attempting emergency cleanup as fallback...');
                try {
                    const emergencyResult = await jobQueue.execute('emergencyCleanup');
                    logger.info('🚨 Emergency cleanup completed', emergencyResult);
                } catch (emergencyError) {
                    logger.error(`🚨 Emergency cleanup also failed: ${emergencyError.message}`);
                }
            }

        } finally {
            cronJobRecord.completedAt = new Date();
            try {
                await cronJobRecord.save();
            } catch (dbError) {
                logger.error(`Database error saving midnight cleanup job: ${dbError.message}`);
            }
        }
    });

    logger.info(`🕛 Midnight cleanup scheduled for 00:00 IST daily (${SMART_CONFIG.DATA_RETENTION_MODE} mode)`);
};

/**
 * Get the appropriate data retention job name based on configuration
 */
const getDataRetentionJobName = () => {
    switch (SMART_CONFIG.DATA_RETENTION_MODE) {
        case 'selective':
            return 'selectiveDataRetention';
        case 'emergency':
            return 'emergencyCleanup';
        case 'aggressive':
        default:
            return 'aggressiveDataRetention';
    }
};

/**
 * Adaptive monitoring based on time of day and system load
 */
const startAdaptiveMonitoring = () => {
    logger.info('🧠 Starting ADAPTIVE monitoring system...');

    cron.schedule('* * * * *', async () => {
        const now = moment().tz(SMART_CONFIG.TIMEZONE);
        const currentHour = now.hour();

        // Determine current period
        let interval;
        if (currentHour >= SMART_CONFIG.PEAK_HOURS.start &&
            currentHour < SMART_CONFIG.PEAK_HOURS.end) {
            interval = 'peak';
        } else if (currentHour >= 22 || currentHour < 6) {
            interval = 'quiet';
        } else {
            interval = 'normal';
        }

        const shouldRunCheck = shouldRunAdaptiveCheck(interval, now);

        if (shouldRunCheck) {
            await executeSmartMonitoring(interval);
        }
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
 * Determine if we should run a check based on adaptive schedule
 */
const shouldRunAdaptiveCheck = (interval, now) => {
    const minute = now.minute();

    switch (interval) {
        case 'peak':
            return minute % 2 === 0; // Every 2 minutes
        case 'normal':
            return minute % 3 === 0; // Every 3 minutes
        case 'quiet':
            return minute % 5 === 0; // Every 5 minutes
        default:
            return minute % 3 === 0;
    }
};

/**
 * Execute smart monitoring with enhanced logging
 */
const executeSmartMonitoring = async (interval) => {
    const jobName = 'smartCheckServers';
    const startTime = new Date();

    const cronJobRecord = new CronJob({
        name: jobName,
        status: 'running',
        startedAt: startTime,
        timezone: SMART_CONFIG.TIMEZONE
    });

    try {
        await cronJobRecord.save();

        if (interval !== 'basic') {
            logger.debug(`🔄 Smart monitoring (${interval} mode) - ${moment().tz(SMART_CONFIG.TIMEZONE).format('HH:mm:ss')}`);
        }

        const result = await jobQueue.execute(jobName);

        if (result === false) {
            cronJobRecord.status = 'skipped';
        } else {
            const duration = Date.now() - startTime.getTime();

            // Only log detailed results for significant activity
            if (result.checked > 0 || result.alertsSent > 0) {
                logger.info(`✅ Monitoring (${interval}) completed`, {
                    checked: result.checked,
                    up: result.up,
                    down: result.down,
                    alerts: result.alertsSent,
                    duration: `${duration}ms`
                });
            }

            cronJobRecord.status = 'completed';
            cronJobRecord.result = {
                ...result,
                interval,
                duration
            };
        }

    } catch (error) {
        logger.error(`❌ Monitoring error (${interval}): ${error.message}`);
        cronJobRecord.status = 'failed';
        cronJobRecord.error = error.message;

    } finally {
        cronJobRecord.completedAt = new Date();
        try {
            await cronJobRecord.save();
        } catch (dbError) {
            logger.error(`Database error saving monitoring job: ${dbError.message}`);
        }
    }
};

/**
 * Health monitoring - check system health every 15 minutes
 */
const startHealthMonitoring = () => {
    cron.schedule('*/15 * * * *', async () => {
        try {
            const healthStats = await getSystemHealth();

            if (healthStats.issues.length > 0) {
                logger.warn('⚠️ System health issues detected:', healthStats.issues);

                // Auto-trigger emergency cleanup if database is too large
                if (healthStats.dbSizeMB > 1000) {
                    logger.warn('🚨 Database size critical, scheduling emergency cleanup...');
                    try {
                        await jobQueue.execute('emergencyCleanup');
                    } catch (cleanupError) {
                        logger.error(`Emergency cleanup failed: ${cleanupError.message}`);
                    }
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
 * Get enhanced system health statistics
 */
const getSystemHealth = async () => {
    const health = {
        issues: [],
        activeJobs: 0,
        dbSizeMB: 0,
        memoryUsage: process.memoryUsage()
    };

    try {
        // Check recent job failures
        const recentFailures = await CronJob.countDocuments({
            startedAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
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
        const dbStats = await aggressiveDataRetention.getCleanupRecommendations();
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
 * Log system information on startup
 */
const logSystemInfo = async () => {
    try {
        const now = new Date();
        const istTime = moment().tz(SMART_CONFIG.TIMEZONE).format('YYYY-MM-DD HH:mm:ss');

        logger.info('🌟 Smart Monitoring System with Midnight Cleanup Started', {
            utcTime: now.toISOString(),
            istTime: istTime,
            timezone: SMART_CONFIG.TIMEZONE,
            dataRetentionMode: SMART_CONFIG.DATA_RETENTION_MODE,
            smartMonitoring: SMART_CONFIG.SMART_MONITORING_ENABLED,
            peakHours: `${SMART_CONFIG.PEAK_HOURS.start}:00 - ${SMART_CONFIG.PEAK_HOURS.end}:00`,
            nextMidnightCleanup: '00:00 IST daily',
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
        const recommendations = await aggressiveDataRetention.getCleanupRecommendations();

        logger.info('📊 Current Data Status:', {
            serverChecks: recommendations.current.serverChecks,
            cronJobs: recommendations.current.cronJobs,
            databaseSize: `${recommendations.current.totalSizeMB} MB`,
            recommendedMode: recommendations.recommendation,
            currentMode: SMART_CONFIG.DATA_RETENTION_MODE,
            reasoning: recommendations.reasoning
        });

        if (recommendations.recommendation !== SMART_CONFIG.DATA_RETENTION_MODE) {
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
    logger.info('🛑 Graceful shutdown initiated...');

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

        logger.info('✅ Graceful shutdown completed');

    } catch (error) {
        logger.error(`Error during graceful shutdown: ${error.message}`);
    }
};

// Register shutdown handlers
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

export default { initCronJobs, gracefulShutdown };