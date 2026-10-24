// tasks/aggressiveDataRetention.js - MIDNIGHT NUCLEAR CLEANUP 💀

import logger from '../utils/logger.js';
import ServerCheck from '../models/ServerCheck.js';
import CronJob from '../models/CronJob.js';
import mongoose from 'mongoose';

/**
 * AGGRESSIVE data retention - clears almost everything at midnight
 * Perfect for scaling without storage concerns
 * @returns {Object} Statistics about the cleanup process
 */
export const runAggressiveDataRetention = async () => {
    const startTime = Date.now();
    logger.info('💀 Starting AGGRESSIVE midnight data cleanup...');

    const stats = {
        serverChecksDeleted: 0,
        cronJobsDeleted: 0,
        oldServerChecksDeleted: 0,
        databaseSizeBeforeMB: 0,
        databaseSizeAfterMB: 0,
        duration: 0
    };

    try {
        // Get database size before cleanup
        const dbStats = await mongoose.connection.db.stats();
        stats.databaseSizeBeforeMB = Math.round(dbStats.dataSize / 1024 / 1024);

        logger.info(`Database size before cleanup: ${stats.databaseSizeBeforeMB} MB`);

        // ========================================
        // STEP 1: Clear ALL ServerCheck data
        // ========================================
        logger.info('🗑️ Deleting ALL ServerCheck records...');

        const serverCheckResult = await ServerCheck.deleteMany({});
        stats.serverChecksDeleted = serverCheckResult.deletedCount;

        logger.info(`✅ Deleted ${stats.serverChecksDeleted} ServerCheck records`);

        // ========================================
        // STEP 2: Clear old CronJob logs (keep last 24 hours only)
        // ========================================
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        logger.info('🗑️ Deleting old CronJob logs (keeping last 24 hours)...');

        const cronJobResult = await CronJob.deleteMany({
            startedAt: { $lt: twentyFourHoursAgo }
        });
        stats.cronJobsDeleted = cronJobResult.deletedCount;

        logger.info(`✅ Deleted ${stats.cronJobsDeleted} old CronJob records`);

        // ========================================
        // STEP 3: Database optimization
        // ========================================
        logger.info('🔧 Running database optimization...');

        try {
            // Compact collections to reclaim space
            await mongoose.connection.db.command({ compact: 'serverchecks' });
            await mongoose.connection.db.command({ compact: 'cronjobs' });
            logger.info('✅ Database compaction completed');
        } catch (compactError) {
            logger.warn(`Database compaction warning: ${compactError.message}`);
            // Don't fail the entire process for compaction issues
        }

        // ========================================
        // STEP 4: Get final database size
        // ========================================
        const dbStatsAfter = await mongoose.connection.db.stats();
        stats.databaseSizeAfterMB = Math.round(dbStatsAfter.dataSize / 1024 / 1024);

        const spaceSaved = stats.databaseSizeBeforeMB - stats.databaseSizeAfterMB;

        stats.duration = Date.now() - startTime;

        logger.info('💀 AGGRESSIVE cleanup completed successfully!', {
            ...stats,
            spaceSavedMB: spaceSaved,
            percentReduction: stats.databaseSizeBeforeMB > 0 ?
                Math.round((spaceSaved / stats.databaseSizeBeforeMB) * 100) : 0
        });

        return {
            ...stats,
            spaceSavedMB: spaceSaved,
            success: true
        };

    } catch (error) {
        stats.duration = Date.now() - startTime;
        logger.error(`💥 Error in aggressive data retention: ${error.message}`, {
            stack: error.stack,
            stats
        });

        throw error;
    }
};

/**
 * SELECTIVE data retention - keeps recent data for analytics
 * Use this when you want to retain some data for dashboards
 * @param {Number} hoursToKeep - Hours of data to retain (default: CHECK_DATA_RETENTION_DAYS, 7 days).
 *   The history API serves up to 30 days, so keeping only 24 hours made the 7d/30d views and the paid
 *   "historical reporting" feature show a single day.
 * @returns {Object} Statistics about the cleanup process
 */
export const runSelectiveDataRetention = async (hoursToKeep = (parseInt(process.env.CHECK_DATA_RETENTION_DAYS, 10) || 7) * 24) => {
    const startTime = Date.now();
    logger.info(`🎯 Starting SELECTIVE data cleanup (keeping last ${hoursToKeep} hours)...`);

    const stats = {
        serverChecksDeleted: 0,
        cronJobsDeleted: 0,
        serverChecksKept: 0,
        duration: 0
    };

    try {
        // Calculate cutoff time
        const cutoffTime = new Date(Date.now() - hoursToKeep * 60 * 60 * 1000);

        logger.info(`🗑️ Deleting ServerCheck records older than ${cutoffTime.toISOString()}`);

        // Delete old ServerCheck records
        const serverCheckResult = await ServerCheck.deleteMany({
            timestamp: { $lt: cutoffTime }
        });
        stats.serverChecksDeleted = serverCheckResult.deletedCount;

        // Count remaining records
        stats.serverChecksKept = await ServerCheck.countDocuments();

        // Delete old CronJob logs (keep a week)
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const cronJobResult = await CronJob.deleteMany({
            startedAt: { $lt: weekAgo }
        });
        stats.cronJobsDeleted = cronJobResult.deletedCount;

        stats.duration = Date.now() - startTime;

        logger.info('🎯 SELECTIVE cleanup completed successfully!', stats);
        return { ...stats, success: true };

    } catch (error) {
        stats.duration = Date.now() - startTime;
        logger.error(`💥 Error in selective data retention: ${error.message}`, {
            stack: error.stack,
            stats
        });

        throw error;
    }
};

/**
 * EMERGENCY cleanup - use when database is critically full
 * Clears everything except essential server configurations
 * @returns {Object} Statistics about the emergency cleanup
 */
export const runEmergencyCleanup = async () => {
    const startTime = Date.now();
    logger.warn('🚨 EMERGENCY CLEANUP INITIATED - CLEARING ALL HISTORICAL DATA');

    const stats = {
        serverChecksDeleted: 0,
        cronJobsDeleted: 0,
        duration: 0,
        emergency: true
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

        logger.warn('🚨 EMERGENCY cleanup completed!', stats);
        return { ...stats, success: true };

    } catch (error) {
        stats.duration = Date.now() - startTime;
        logger.error(`💥 EMERGENCY cleanup failed: ${error.message}`, {
            stack: error.stack,
            stats
        });

        throw error;
    }
};

/**
 * Get cleanup recommendations based on current data volume
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
                totalSizeMB: dbSizeMB + indexSizeMB
            },
            recommendation,
            reasoning,
            actions: {
                aggressive: 'Clear all historical data daily',
                selective: `Keep last 24 hours of data`,
                emergency: 'Clear everything immediately'
            }
        };

    } catch (error) {
        logger.error(`Error getting cleanup recommendations: ${error.message}`);
        return {
            current: { error: error.message },
            recommendation: 'aggressive',
            reasoning: 'Error analyzing data, defaulting to aggressive cleanup'
        };
    }
};

export default {
    runAggressiveDataRetention,
    runSelectiveDataRetention,
    runEmergencyCleanup,
    getCleanupRecommendations
};