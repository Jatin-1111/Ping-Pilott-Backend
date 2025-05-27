// tasks/index.js - PURE IST TIMEZONE SCHEDULER 🇮🇳

import dotenv from 'dotenv';
dotenv.config();

import cron from 'node-cron';
import logger from '../utils/logger.js';
import istDataRetention from './dataRetention.js';
import smartCheckServers from './checkServers.js';
import jobQueue from '../utils/jobQueue.js';
import CronJob from '../models/CronJob.js';
import moment from 'moment-timezone';

// PURE IST CONFIGURATION - NO UTC/OTHER TIMEZONE MIXING
const IST_CONFIG = {
    TIMEZONE: 'Asia/Kolkata',
    DATA_RETENTION_MODE: process.env.DATA_RETENTION_MODE || 'aggressive',

    // Midnight IST = 18:30 UTC (but we don't care about UTC anymore)
    MIDNIGHT_CRON: '0 0 * * *', // This runs at IST midnight, not UTC

    // Peak hours in IST
    PEAK_HOURS: {
        start: parseInt(process.env.PEAK_HOURS_START) || 9,  // 9 AM IST
        end: parseInt(process.env.PEAK_HOURS_END) || 18      // 6 PM IST
    },

    SMART_MONITORING_ENABLED: process.env.SMART_MONITORING_ENABLED === 'true'
};

// Set system timezone to IST everywhere
process.env.TZ = 'Asia/Kolkata';
moment.tz.setDefault('Asia/Kolkata');

/**
 * Get current IST time - ONLY IST
 */
const getISTTime = () => {
    return moment().tz(IST_CONFIG.TIMEZONE);
};

/**
 * Initialize PURE IST cron jobs
 */
export const initCronJobs = async () => {
    try {
        logger.info('🇮🇳 Initializing PURE IST cron jobs...');

        // Initialize job queue with all tasks
        jobQueue.add('smartCheckServers', smartCheckServers.checkAllServersIntelligently, 1);
        jobQueue.add('aggressiveDataRetention', istDataRetention.runAggressiveDataRetention, 2);
        jobQueue.add('selectiveDataRetention', istDataRetention.runSelectiveDataRetention, 2);
        jobQueue.add('emergencyCleanup', istDataRetention.runEmergencyCleanup, 3);

        // Log system info
        await logISTSystemInfo();
        await logCleanupRecommendations();

        // Start monitoring based on configuration
        if (IST_CONFIG.SMART_MONITORING_ENABLED) {
            startISTAdaptiveMonitoring();
        } else {
            startISTBasicMonitoring();
        }

        // THE MAIN EVENT: IST Midnight cleanup 🕛
        startISTMidnightCleanup();

        // Health monitoring in IST
        startISTHealthMonitoring();

        logger.info('✅ All PURE IST cron jobs initialized successfully');

    } catch (error) {
        logger.error(`❌ Error initializing IST cron jobs: ${error.message}`);
        throw error;
    }
};

/**
 * IST MIDNIGHT CLEANUP - Runs at exactly 00:00 IST every day
 * NO MORE UTC CONFUSION! 
 */
const startISTMidnightCleanup = () => {
    // Set timezone explicitly for this cron job
    cron.schedule(IST_CONFIG.MIDNIGHT_CRON, async () => {
        const jobName = getDataRetentionJobName();
        const startTime = new Date();
        const istTime = getISTTime();

        const cronJobRecord = new CronJob({
            name: jobName,
            status: 'running',
            startedAt: startTime,
            timezone: IST_CONFIG.TIMEZONE
        });

        try {
            await cronJobRecord.save();

            logger.info(`💀 Starting IST MIDNIGHT CLEANUP at ${istTime.format('YYYY-MM-DD HH:mm:ss')} IST`);
            logger.info(`🎯 Cleanup mode: ${IST_CONFIG.DATA_RETENTION_MODE.toUpperCase()}`);

            const result = await jobQueue.execute(jobName);

            if (result === false) {
                logger.info('IST midnight cleanup already running, skipping');
                cronJobRecord.status = 'skipped';
            } else {
                const duration = Date.now() - startTime.getTime();
                logger.info('✅ IST MIDNIGHT CLEANUP completed successfully!', {
                    ...result,
                    duration,
                    mode: IST_CONFIG.DATA_RETENTION_MODE,
                    istCompletedAt: getISTTime().format('YYYY-MM-DD HH:mm:ss')
                });

                cronJobRecord.status = 'completed';
                cronJobRecord.result = {
                    ...result,
                    duration,
                    mode: IST_CONFIG.DATA_RETENTION_MODE,
                    istCompletedAt: getISTTime().format('YYYY-MM-DD HH:mm:ss')
                };

                // Log space savings if available
                if (result.spaceSavedMB) {
                    logger.info(`💾 Space saved: ${result.spaceSavedMB} MB`);
                }
            }

        } catch (error) {
            logger.error(`💥 IST MIDNIGHT CLEANUP ERROR: ${error.message}`);
            cronJobRecord.status = 'failed';
            cronJobRecord.error = error.message;

            // Try emergency cleanup if regular cleanup fails
            if (IST_CONFIG.DATA_RETENTION_MODE !== 'emergency') {
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
                logger.error(`Database error saving IST midnight cleanup job: ${dbError.message}`);
            }
        }
    }, {
        scheduled: true,
        timezone: IST_CONFIG.TIMEZONE // CRITICAL: This ensures cron runs in IST
    });

    logger.info(`🕛 IST Midnight cleanup scheduled for 00:00 IST daily (${IST_CONFIG.DATA_RETENTION_MODE} mode)`);
};

/**
 * IST Adaptive monitoring based on IST time of day
 */
const startISTAdaptiveMonitoring = () => {
    logger.info('🧠 Starting IST ADAPTIVE monitoring system...');

    // Run every minute but check IST time for decisions
    cron.schedule('* * * * *', async () => {
        const istNow = getISTTime();
        const currentHour = istNow.hour();
        const currentMinute = istNow.minute();

        // Determine current period based on IST hours
        let interval;
        if (currentHour >= IST_CONFIG.PEAK_HOURS.start &&
            currentHour < IST_CONFIG.PEAK_HOURS.end) {
            interval = 'peak';
        } else if (currentHour >= 22 || currentHour < 6) {
            interval = 'quiet';
        } else {
            interval = 'normal';
        }

        const shouldRunCheck = shouldRunISTAdaptiveCheck(interval, currentMinute);

        if (shouldRunCheck) {
            await executeISTSmartMonitoring(interval, istNow);
        }
    }, {
        scheduled: true,
        timezone: IST_CONFIG.TIMEZONE
    });
};

/**
 * Basic IST monitoring - fallback when smart monitoring is disabled
 */
const startISTBasicMonitoring = () => {
    logger.info('⚡ Starting IST BASIC monitoring system (every 3 minutes)...');

    cron.schedule('*/3 * * * *', async () => {
        const istNow = getISTTime();
        await executeISTSmartMonitoring('basic', istNow);
    }, {
        scheduled: true,
        timezone: IST_CONFIG.TIMEZONE
    });
};

/**
 * IST Health monitoring - check system health every 15 minutes in IST
 */
const startISTHealthMonitoring = () => {
    cron.schedule('*/15 * * * *', async () => {
        const istNow = getISTTime();

        try {
            const healthStats = await getISTSystemHealth();

            if (healthStats.issues.length > 0) {
                logger.warn('⚠️ IST System health issues detected:', {
                    ...healthStats.issues,
                    istTime: istNow.format('YYYY-MM-DD HH:mm:ss')
                });

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
                logger.debug('💚 IST System health OK', {
                    memory: `${Math.round(healthStats.memoryUsage.heapUsed / 1024 / 1024)}MB`,
                    db: `${healthStats.dbSizeMB}MB`,
                    istTime: istNow.format('YYYY-MM-DD HH:mm:ss')
                });
            }

        } catch (error) {
            logger.error(`IST Health monitoring error: ${error.message}`);
        }
    }, {
        scheduled: true,
        timezone: IST_CONFIG.TIMEZONE
    });
};

/**
 * Determine if we should run a check based on IST adaptive schedule
 */
const shouldRunISTAdaptiveCheck = (interval, currentMinute) => {
    switch (interval) {
        case 'peak':
            return currentMinute % 2 === 0; // Every 2 minutes during peak IST hours
        case 'normal':
            return currentMinute % 3 === 0; // Every 3 minutes during normal IST hours
        case 'quiet':
            return currentMinute % 5 === 0; // Every 5 minutes during quiet IST hours
        default:
            return currentMinute % 3 === 0;
    }
};

/**
 * Execute smart monitoring with IST logging
 */
const executeISTSmartMonitoring = async (interval, istTime) => {
    const jobName = 'smartCheckServers';
    const startTime = new Date();

    const cronJobRecord = new CronJob({
        name: jobName,
        status: 'running',
        startedAt: startTime,
        timezone: IST_CONFIG.TIMEZONE
    });

    try {
        await cronJobRecord.save();

        if (interval !== 'basic') {
            logger.debug(`🔄 IST Smart monitoring (${interval} mode) - ${istTime.format('HH:mm:ss')}`);
        }

        const result = await jobQueue.execute(jobName);

        if (result === false) {
            cronJobRecord.status = 'skipped';
        } else {
            const duration = Date.now() - startTime.getTime();

            // Only log detailed results for significant activity
            if (result.checked > 0 || result.alertsSent > 0) {
                logger.info(`✅ IST Monitoring (${interval}) completed`, {
                    checked: result.checked,
                    up: result.up,
                    down: result.down,
                    alerts: result.alertsSent,
                    duration: `${duration}ms`,
                    istTime: istTime.format('HH:mm:ss')
                });
            }

            cronJobRecord.status = 'completed';
            cronJobRecord.result = {
                ...result,
                interval,
                duration,
                istCompletedAt: getISTTime().format('YYYY-MM-DD HH:mm:ss')
            };
        }

    } catch (error) {
        logger.error(`❌ IST Monitoring error (${interval}): ${error.message}`);
        cronJobRecord.status = 'failed';
        cronJobRecord.error = error.message;

    } finally {
        cronJobRecord.completedAt = new Date();
        try {
            await cronJobRecord.save();
        } catch (dbError) {
            logger.error(`Database error saving IST monitoring job: ${dbError.message}`);
        }
    }
};

/**
 * Get IST system health statistics
 */
const getISTSystemHealth = async () => {
    const health = {
        issues: [],
        activeJobs: 0,
        dbSizeMB: 0,
        memoryUsage: process.memoryUsage(),
        istTime: getISTTime().format('YYYY-MM-DD HH:mm:ss')
    };

    try {
        // Check recent job failures
        const oneHourAgoIST = getISTTime().subtract(1, 'hour').toDate();
        const recentFailures = await CronJob.countDocuments({
            startedAt: { $gte: oneHourAgoIST },
            status: 'failed'
        });

        if (recentFailures > 5) {
            health.issues.push(`${recentFailures} job failures in the last IST hour`);
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
        health.issues.push(`IST Health check error: ${error.message}`);
    }

    return health;
};

/**
 * Get the appropriate data retention job name based on configuration
 */
const getDataRetentionJobName = () => {
    switch (IST_CONFIG.DATA_RETENTION_MODE) {
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
 * Log IST system information on startup
 */
const logISTSystemInfo = async () => {
    try {
        const istNow = getISTTime();

        logger.info('🇮🇳 PURE IST Monitoring System Started', {
            istTime: istNow.format('YYYY-MM-DD HH:mm:ss'),
            timezone: IST_CONFIG.TIMEZONE,
            dataRetentionMode: IST_CONFIG.DATA_RETENTION_MODE,
            smartMonitoring: IST_CONFIG.SMART_MONITORING_ENABLED,
            peakHoursIST: `${IST_CONFIG.PEAK_HOURS.start}:00 - ${IST_CONFIG.PEAK_HOURS.end}:00 IST`,
            midnightCleanup: '00:00 IST daily',
            nodeVersion: process.version,
            platform: process.platform,
            processTimezone: process.env.TZ
        });

    } catch (error) {
        logger.error(`Error logging IST system info: ${error.message}`);
    }
};

/**
 * Log cleanup recommendations in IST
 */
const logCleanupRecommendations = async () => {
    try {
        const recommendations = await istDataRetention.getCleanupRecommendations();

        logger.info('📊 Current Data Status (IST):', {
            serverChecks: recommendations.current.serverChecks,
            cronJobs: recommendations.current.cronJobs,
            databaseSize: `${recommendations.current.totalSizeMB} MB`,
            recommendedMode: recommendations.recommendation,
            currentMode: IST_CONFIG.DATA_RETENTION_MODE,
            reasoning: recommendations.reasoning,
            analyzedAtIST: recommendations.current.analyzedAt
        });

        if (recommendations.recommendation !== IST_CONFIG.DATA_RETENTION_MODE) {
            logger.warn(`💡 Recommendation: Consider switching to '${recommendations.recommendation}' mode`);
            logger.warn(`Reason: ${recommendations.reasoning}`);
        }

    } catch (error) {
        logger.error(`Error getting IST cleanup recommendations: ${error.message}`);
    }
};

/**
 * Graceful shutdown handler with IST logging
 */
const gracefulShutdown = async () => {
    const istTime = getISTTime();
    logger.info('🛑 IST Graceful shutdown initiated...', {
        istTime: istTime.format('YYYY-MM-DD HH:mm:ss')
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

        logger.info('✅ IST Graceful shutdown completed', {
            shutdownAtIST: getISTTime().format('YYYY-MM-DD HH:mm:ss')
        });

    } catch (error) {
        logger.error(`Error during IST graceful shutdown: ${error.message}`);
    }
};

// Register shutdown handlers
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

export default { initCronJobs, gracefulShutdown };