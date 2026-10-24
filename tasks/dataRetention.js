// tasks/dataRetention.js - the midnight clean-up of old history

import logger from '../utils/logger.js';
import ServerCheck from '../models/ServerCheck.js';
import CronJob from '../models/CronJob.js';
import mongoose from 'mongoose';
import { resolveRetentionDays } from '../utils/retention.js';

/**
 * Delete check history older than the retention period, and job logs older than a week.
 * @param {Number} days - How many days of checks to keep (default: CHECK_DATA_RETENTION_DAYS, 30)
 * @returns {Object} Statistics about the cleanup process
 */
export const runDataRetention = async (days = resolveRetentionDays(process.env.CHECK_DATA_RETENTION_DAYS).days) => {
    const startTime = Date.now();
    logger.info(`Starting data clean-up (keeping the last ${days} days of checks)...`);

    const stats = {
        serverChecksDeleted: 0,
        cronJobsDeleted: 0,
        serverChecksKept: 0,
        retentionDays: days,
        duration: 0
    };

    try {
        const cutoffTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        logger.info(`Deleting ServerCheck records older than ${cutoffTime.toISOString()}`);

        const serverCheckResult = await ServerCheck.deleteMany({
            timestamp: { $lt: cutoffTime }
        });
        stats.serverChecksDeleted = serverCheckResult.deletedCount;

        stats.serverChecksKept = await ServerCheck.countDocuments();

        // Job logs are for debugging: a week is plenty
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const cronJobResult = await CronJob.deleteMany({
            startedAt: { $lt: weekAgo }
        });
        stats.cronJobsDeleted = cronJobResult.deletedCount;

        stats.duration = Date.now() - startTime;

        logger.info('Data clean-up completed', stats);
        return { ...stats, success: true };

    } catch (error) {
        stats.duration = Date.now() - startTime;
        logger.error(`Error in data retention: ${error.message}`, {
            stack: error.stack,
            stats
        });

        throw error;
    }
};

/**
 * Size of the database in MB (data plus indexes), for the 15 minute health log
 */
export const getDatabaseSizeMB = async () => {
    const dbStats = await mongoose.connection.db.stats();
    return Math.round((dbStats.dataSize + dbStats.indexSize) / 1024 / 1024);
};

export default { runDataRetention, getDatabaseSizeMB };
