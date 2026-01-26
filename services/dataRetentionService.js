// services/dataRetentionService.js - System Time Data Retention

import logger from '../utils/logger.js';
import ServerCheck from '../models/ServerCheck.js';
import CronJob from '../models/CronJob.js';
import mongoose from 'mongoose';

/**
 * Get date string (YYYY-MM-DD) for a given date
 */
const getDateString = (date = new Date()) => {
    return date.toISOString().split('T')[0];
};

/**
 * AGGRESSIVE data retention - clears almost everything at midnight
 * @returns {Object} Statistics about the cleanup process
 */
export const runAggressiveDataRetention = async () => {
    const startTime = Date.now();
    const now = new Date();

    logger.info('💀 Starting AGGRESSIVE midnight data cleanup...', {
        time: now.toISOString()
    });

    const stats = {
        serverChecksDeleted: 0,
        cronJobsDeleted: 0,
        databaseSizeBeforeMB: 0,
        databaseSizeAfterMB: 0,
        duration: 0,
        cleanupDate: getDateString(),
        spaceSavedMB: 0
    };

    try {
        // Get database size before cleanup
        try {
            const dbStats = await mongoose.connection.db.stats();
            stats.databaseSizeBeforeMB = Math.round(dbStats.dataSize / 1024 / 1024);
        } catch (dbError) {
            logger.warn(`Could not get DB stats: ${dbError.message}`);
            stats.databaseSizeBeforeMB = 0;
        }

        logger.info(`📊 Database size before cleanup: ${stats.databaseSizeBeforeMB} MB`);

        // STEP 1: Clear ALL ServerCheck data
        logger.info('🗑️ Deleting ALL ServerCheck records...');

        const serverCheckResult = await ServerCheck.deleteMany({});
        stats.serverChecksDeleted = serverCheckResult.deletedCount || 0;

        logger.info(`✅ Deleted ${stats.serverChecksDeleted} ServerCheck records`);

        // STEP 2: Clear old CronJob logs (keep last 24 hours)
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        logger.info('🗑️ Deleting old CronJob logs (keeping last 24 hours)...', {
            cutoffTime: twentyFourHoursAgo.toISOString()
        });

        const cronJobResult = await CronJob.deleteMany({
            startedAt: { $lt: twentyFourHoursAgo }
        });
        stats.cronJobsDeleted = cronJobResult.deletedCount || 0;

        logger.info(`✅ Deleted ${stats.cronJobsDeleted} old CronJob records`);

        // STEP 3: Database optimization
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

        // STEP 4: Get final database size
        try {
            const dbStatsAfter = await mongoose.connection.db.stats();
            stats.databaseSizeAfterMB = Math.round(dbStatsAfter.dataSize / 1024 / 1024);
        } catch (dbError) {
            logger.warn(`Could not get final DB stats: ${dbError.message}`);
            stats.databaseSizeAfterMB = 0;
        }

        const spaceSaved = Math.max(0, stats.databaseSizeBeforeMB - stats.databaseSizeAfterMB);
        stats.spaceSavedMB = spaceSaved;
        stats.duration = Date.now() - startTime;

        logger.info('💀 AGGRESSIVE cleanup completed successfully!', {
            ...stats,
            percentReduction: stats.databaseSizeBeforeMB > 0 ?
                Math.round((spaceSaved / stats.databaseSizeBeforeMB) * 100) : 0,
            completedAt: new Date().toISOString()
        });

        return {
            ...stats,
            success: true
        };

    } catch (error) {
        stats.duration = Date.now() - startTime;
        logger.error(`💥 Error in aggressive data retention: ${error.message}`, {
            stack: error.stack,
            stats,
            time: new Date().toISOString()
        });

        throw error;
    }
};

/**
 * SELECTIVE data retention - keeps recent data for analytics
 * @param {Number} hoursToKeep - Hours of data to retain (default: 24)
 * @returns {Object} Statistics about the cleanup process
 */
export const runSelectiveDataRetention = async (hoursToKeep = 24) => {
    const startTime = Date.now();
    const now = new Date();

    logger.info(`🎯 Starting SELECTIVE data cleanup (keeping last ${hoursToKeep} hours)...`, {
        time: now.toISOString()
    });

    const stats = {
        serverChecksDeleted: 0,
        cronJobsDeleted: 0,
        serverChecksKept: 0,
        duration: 0,
        cleanupDate: getDateString()
    };

    try {
        // Calculate cutoff time
        const cutoffTime = new Date(Date.now() - hoursToKeep * 60 * 60 * 1000);

        logger.info(`🗑️ Deleting ServerCheck records older than ${cutoffTime.toISOString()}`);

        // Delete old ServerCheck records
        const serverCheckResult = await ServerCheck.deleteMany({
            timestamp: { $lt: cutoffTime }
        });
        stats.serverChecksDeleted = serverCheckResult.deletedCount || 0;

        // Count remaining records
        stats.serverChecksKept = await ServerCheck.countDocuments();

        // Delete old CronJob logs (keep last 48 hours)
        const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
        const cronJobResult = await CronJob.deleteMany({
            startedAt: { $lt: fortyEightHoursAgo }
        });
        stats.cronJobsDeleted = cronJobResult.deletedCount || 0;

        stats.duration = Date.now() - startTime;

        logger.info('🎯 SELECTIVE cleanup completed successfully!', {
            ...stats,
            completedAt: new Date().toISOString()
        });

        return { ...stats, success: true };

    } catch (error) {
        stats.duration = Date.now() - startTime;
        logger.error(`💥 Error in selective data retention: ${error.message}`, {
            stack: error.stack,
            stats,
            time: new Date().toISOString()
        });

        throw error;
    }
};

/**
 * EMERGENCY cleanup - use when database is critically full
 * @returns {Object} Statistics about the emergency cleanup
 */
export const runEmergencyCleanup = async () => {
    const startTime = Date.now();
    const now = new Date();

    logger.warn('🚨 EMERGENCY CLEANUP INITIATED - CLEARING ALL HISTORICAL DATA', {
        time: now.toISOString()
    });

    const stats = {
        serverChecksDeleted: 0,
        cronJobsDeleted: 0,
        duration: 0,
        emergency: true,
        cleanupDate: getDateString()
    };

    try {
        // Nuclear option - delete everything
        const [serverCheckResult, cronJobResult] = await Promise.all([
            ServerCheck.deleteMany({}),
            CronJob.deleteMany({})
        ]);

        stats.serverChecksDeleted = serverCheckResult.deletedCount || 0;
        stats.cronJobsDeleted = cronJobResult.deletedCount || 0;
        stats.duration = Date.now() - startTime;

        logger.warn('🚨 EMERGENCY cleanup completed!', {
            ...stats,
            completedAt: new Date().toISOString()
        });

        return { ...stats, success: true };

    } catch (error) {
        stats.duration = Date.now() - startTime;
        logger.error(`💥 EMERGENCY cleanup failed: ${error.message}`, {
            stack: error.stack,
            stats,
            time: new Date().toISOString()
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
        logger.info('🔍 Starting cleanup recommendations...');

        const [serverCheckCount, cronJobCount, dbStatsResult] = await Promise.all([
            ServerCheck.countDocuments().catch(() => 0),
            CronJob.countDocuments().catch(() => 0),
            mongoose.connection.db.stats().catch(() => null)
        ]);

        // Handle database stats safely
        const dbStats = dbStatsResult || { dataSize: 0, indexSize: 0 };

        logger.info('🔍 Got database counts:', { serverCheckCount, cronJobCount, dbStats: !!dbStats });

        const dbSizeMB = Math.round((dbStats.dataSize || 0) / 1024 / 1024);
        const indexSizeMB = Math.round((dbStats.indexSize || 0) / 1024 / 1024);

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
                analyzedAt: new Date().toISOString()
            },
            recommendation,
            reasoning,
            actions: {
                aggressive: 'Clear all historical data daily at midnight',
                selective: 'Keep last 24 hours of data',
                emergency: 'Clear everything immediately'
            }
        };

    } catch (error) {
        logger.error(`Error getting cleanup recommendations: ${error.message}`, {
            stack: error.stack,
            trace: new Error().stack
        });
        return {
            current: {
                error: error.message,
                analyzedAt: new Date().toISOString(),
                serverChecks: 0,
                cronJobs: 0,
                databaseSizeMB: 0,
                indexSizeMB: 0,
                totalSizeMB: 0
            },
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