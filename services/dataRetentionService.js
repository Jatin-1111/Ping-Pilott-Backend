// tasks/dataRetention.js - PURE IST TIMEZONE 🇮🇳

import logger from '../utils/logger.js';
import ServerCheck from '../models/ServerCheck.js';
import CronJob from '../models/CronJob.js';
import mongoose from 'mongoose';
import moment from 'moment-timezone';

// PURE IST CONFIGURATION - NO OTHER TIMEZONES ALLOWED
const IST_CONFIG = {
    TIMEZONE: 'Asia/Kolkata',
    MIDNIGHT_HOUR: 0,
    MIDNIGHT_MINUTE: 0
};

/**
 * Get IST date/time - ONLY IST, NO UTC BULLSHIT
 */
const getISTTime = () => {
    return moment().tz(IST_CONFIG.TIMEZONE);
};

/**
 * Get IST date string (YYYY-MM-DD)
 */
const getISTDateString = (date = null) => {
    const istMoment = date ? moment(date).tz(IST_CONFIG.TIMEZONE) : getISTTime();
    return istMoment.format('YYYY-MM-DD');
};

/**
 * Get yesterday's IST date string
 */
const getYesterdayISTString = () => {
    return getISTTime().subtract(1, 'day').format('YYYY-MM-DD');
};

/**
 * AGGRESSIVE data retention - clears almost everything at IST midnight
 * @returns {Object} Statistics about the cleanup process
 */
export const runAggressiveDataRetention = async () => {
    const startTime = Date.now();
    const istNow = getISTTime();

    logger.info('💀 Starting AGGRESSIVE IST midnight data cleanup...', {
        istTime: istNow.format('YYYY-MM-DD HH:mm:ss'),
        timezone: IST_CONFIG.TIMEZONE
    });

    const stats = {
        serverChecksDeleted: 0,
        cronJobsDeleted: 0,
        databaseSizeBeforeMB: 0,
        databaseSizeAfterMB: 0,
        duration: 0,
        cleanupDate: getISTDateString()
    };

    try {
        // Get database size before cleanup
        const dbStats = await mongoose.connection.db.stats();
        stats.databaseSizeBeforeMB = Math.round(dbStats.dataSize / 1024 / 1024);

        logger.info(`📊 Database size before cleanup: ${stats.databaseSizeBeforeMB} MB`);

        // ========================================
        // STEP 1: Clear ALL ServerCheck data
        // ========================================
        logger.info('🗑️ Deleting ALL ServerCheck records...');

        const serverCheckResult = await ServerCheck.deleteMany({});
        stats.serverChecksDeleted = serverCheckResult.deletedCount;

        logger.info(`✅ Deleted ${stats.serverChecksDeleted} ServerCheck records`);

        // ========================================
        // STEP 2: Clear old CronJob logs (keep last 24 hours IST)
        // ========================================
        const twentyFourHoursAgoIST = getISTTime().subtract(24, 'hours').toDate();

        logger.info('🗑️ Deleting old CronJob logs (keeping last 24 hours IST)...', {
            cutoffTime: moment(twentyFourHoursAgoIST).tz(IST_CONFIG.TIMEZONE).format('YYYY-MM-DD HH:mm:ss')
        });

        const cronJobResult = await CronJob.deleteMany({
            startedAt: { $lt: twentyFourHoursAgoIST }
        });
        stats.cronJobsDeleted = cronJobResult.deletedCount;

        logger.info(`✅ Deleted ${stats.cronJobsDeleted} old CronJob records`);

        // ========================================
        // STEP 3: Database optimization
        // ========================================
        logger.info('🔧 Running database optimization...');

        try {
            await Promise.all([
                mongoose.connection.db.command({ compact: 'serverchecks' }),
                mongoose.connection.db.command({ compact: 'cronjobs' })
            ]);
            logger.info('✅ Database compaction completed');
        } catch (compactError) {
            logger.warn(`Database compaction warning: ${compactError.message}`);
        }

        // ========================================
        // STEP 4: Get final database size
        // ========================================
        const dbStatsAfter = await mongoose.connection.db.stats();
        stats.databaseSizeAfterMB = Math.round(dbStatsAfter.dataSize / 1024 / 1024);

        const spaceSaved = stats.databaseSizeBeforeMB - stats.databaseSizeAfterMB;
        stats.spaceSavedMB = spaceSaved;
        stats.duration = Date.now() - startTime;

        logger.info('💀 AGGRESSIVE IST cleanup completed successfully!', {
            ...stats,
            percentReduction: stats.databaseSizeBeforeMB > 0 ?
                Math.round((spaceSaved / stats.databaseSizeBeforeMB) * 100) : 0,
            completedAt: getISTTime().format('YYYY-MM-DD HH:mm:ss')
        });

        return {
            ...stats,
            success: true
        };

    } catch (error) {
        stats.duration = Date.now() - startTime;
        logger.error(`💥 Error in aggressive IST data retention: ${error.message}`, {
            stack: error.stack,
            stats,
            istTime: getISTTime().format('YYYY-MM-DD HH:mm:ss')
        });

        throw error;
    }
};

/**
 * SELECTIVE data retention - keeps recent data for analytics (IST based)
 * @param {Number} hoursToKeep - Hours of data to retain (default: 24)
 * @returns {Object} Statistics about the cleanup process
 */
export const runSelectiveDataRetention = async (hoursToKeep = 24) => {
    const startTime = Date.now();
    const istNow = getISTTime();

    logger.info(`🎯 Starting SELECTIVE IST data cleanup (keeping last ${hoursToKeep} hours)...`, {
        istTime: istNow.format('YYYY-MM-DD HH:mm:ss')
    });

    const stats = {
        serverChecksDeleted: 0,
        cronJobsDeleted: 0,
        serverChecksKept: 0,
        duration: 0,
        cleanupDate: getISTDateString()
    };

    try {
        // Calculate cutoff time in IST
        const cutoffTimeIST = getISTTime().subtract(hoursToKeep, 'hours');
        const cutoffTimeUTC = cutoffTimeIST.utc().toDate();

        logger.info(`🗑️ Deleting ServerCheck records older than ${cutoffTimeIST.format('YYYY-MM-DD HH:mm:ss')} IST`);

        // Delete old ServerCheck records
        const serverCheckResult = await ServerCheck.deleteMany({
            timestamp: { $lt: cutoffTimeUTC }
        });
        stats.serverChecksDeleted = serverCheckResult.deletedCount;

        // Count remaining records
        stats.serverChecksKept = await ServerCheck.countDocuments();

        // Delete old CronJob logs (keep last 48 hours IST)
        const fortyEightHoursAgoIST = getISTTime().subtract(48, 'hours').toDate();
        const cronJobResult = await CronJob.deleteMany({
            startedAt: { $lt: fortyEightHoursAgoIST }
        });
        stats.cronJobsDeleted = cronJobResult.deletedCount;

        stats.duration = Date.now() - startTime;

        logger.info('🎯 SELECTIVE IST cleanup completed successfully!', {
            ...stats,
            completedAt: getISTTime().format('YYYY-MM-DD HH:mm:ss')
        });

        return { ...stats, success: true };

    } catch (error) {
        stats.duration = Date.now() - startTime;
        logger.error(`💥 Error in selective IST data retention: ${error.message}`, {
            stack: error.stack,
            stats,
            istTime: getISTTime().format('YYYY-MM-DD HH:mm:ss')
        });

        throw error;
    }
};

/**
 * EMERGENCY cleanup - use when database is critically full (IST logged)
 * @returns {Object} Statistics about the emergency cleanup
 */
export const runEmergencyCleanup = async () => {
    const startTime = Date.now();
    const istNow = getISTTime();

    logger.warn('🚨 EMERGENCY IST CLEANUP INITIATED - CLEARING ALL HISTORICAL DATA', {
        istTime: istNow.format('YYYY-MM-DD HH:mm:ss')
    });

    const stats = {
        serverChecksDeleted: 0,
        cronJobsDeleted: 0,
        duration: 0,
        emergency: true,
        cleanupDate: getISTDateString()
    };

    try {
        // Nuclear option - delete everything
        const [serverCheckResult, cronJobResult] = await Promise.all([
            ServerCheck.deleteMany({}),
            CronJob.deleteMany({})
        ]);

        stats.serverChecksDeleted = serverCheckResult.deletedCount;
        stats.cronJobsDeleted = cronJobResult.deletedCount;
        stats.duration = Date.now() - startTime;

        logger.warn('🚨 EMERGENCY IST cleanup completed!', {
            ...stats,
            completedAt: getISTTime().format('YYYY-MM-DD HH:mm:ss')
        });

        return { ...stats, success: true };

    } catch (error) {
        stats.duration = Date.now() - startTime;
        logger.error(`💥 EMERGENCY IST cleanup failed: ${error.message}`, {
            stack: error.stack,
            stats,
            istTime: getISTTime().format('YYYY-MM-DD HH:mm:ss')
        });

        throw error;
    }
};

/**
 * Get cleanup recommendations based on current data volume (IST aware)
 * @returns {Object} Recommendations for data retention strategy
 */
export const getCleanupRecommendations = async () => {
    try {
        const [serverCheckCount, cronJobCount, dbStats] = await Promise.all([
            ServerCheck.countDocuments(),
            CronJob.countDocuments(),
            mongoose.connection.db.stats()
        ]);

        const dbSizeMB = Math.round(dbStats.dataSize / 1024 / 1024);
        const indexSizeMB = Math.round(dbStats.indexSize / 1024 / 1024);

        let recommendation = 'selective';
        let reasoning = 'Current data volume is manageable';

        if (dbSizeMB > 500) {
            recommendation = 'aggressive';
            reasoning = 'Database size is getting large (>500MB)';
        }

        if (dbSizeMB > 1000) {
            recommendation = 'emergency';
            reasoning = 'Database size is critical (>1GB)';
        }

        if (serverCheckCount > 100000) {
            recommendation = 'aggressive';
            reasoning = 'Too many ServerCheck records (>100k)';
        }

        return {
            current: {
                serverChecks: serverCheckCount,
                cronJobs: cronJobCount,
                databaseSizeMB: dbSizeMB,
                indexSizeMB: indexSizeMB,
                totalSizeMB: dbSizeMB + indexSizeMB,
                analyzedAt: getISTTime().format('YYYY-MM-DD HH:mm:ss'),
                timezone: IST_CONFIG.TIMEZONE
            },
            recommendation,
            reasoning,
            actions: {
                aggressive: 'Clear all historical data daily at IST midnight',
                selective: 'Keep last 24 hours of data (IST based)',
                emergency: 'Clear everything immediately'
            }
        };

    } catch (error) {
        logger.error(`Error getting cleanup recommendations: ${error.message}`);
        return {
            current: {
                error: error.message,
                analyzedAt: getISTTime().format('YYYY-MM-DD HH:mm:ss'),
                timezone: IST_CONFIG.TIMEZONE
            },
            recommendation: 'aggressive',
            reasoning: 'Error analyzing data, defaulting to aggressive cleanup'
        };
    }
};

/**
 * IST Helper functions for other modules
 */
export const istHelpers = {
    getISTTime,
    getISTDateString,
    getYesterdayISTString,

    // Check if it's IST midnight (within 5 minutes)
    isISTMidnight: () => {
        const now = getISTTime();
        const hour = now.hour();
        const minute = now.minute();

        return hour === 0 && minute >= 0 && minute <= 5;
    },

    // Get IST midnight for a specific date
    getISTMidnight: (date = null) => {
        const istDate = date ? moment(date).tz(IST_CONFIG.TIMEZONE) : getISTTime();
        return istDate.startOf('day'); // This gives 00:00:00 IST
    },

    // Convert any date to IST
    toIST: (date) => {
        return moment(date).tz(IST_CONFIG.TIMEZONE);
    }
};

export default {
    runAggressiveDataRetention,
    runSelectiveDataRetention,
    runEmergencyCleanup,
    getCleanupRecommendations,
    istHelpers
};