import logger from '../utils/logger.js';
import ServerCheck from '../models/ServerCheck.js';
import CronJob from '../models/CronJob.js';

/**
 * Run data retention/cleanup process
 * Archives old check data and removes it from the active collection
 * @returns {Object} Statistics about the retention process
 */
export const runDataRetention = async () => {
    logger.info('Starting data retention process');

    const stats = {
        checksDeleted: 0
    };

    try {
        // Calculate yesterday's date
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        logger.info(`Deleting all check data for date: ${yesterdayStr}`);

        // Delete all of yesterday's checks
        const result = await ServerCheck.deleteMany({ date: { $lte: yesterdayStr } });

        stats.checksDeleted = result.deletedCount;
        logger.info(`Deleted ${result.deletedCount} checks from previous days`);

        logger.info('Data retention process completed successfully', { stats });
        return stats;
    } catch (error) {
        logger.error(`Error in data retention process: ${error.message}`);
        throw error;
    }
};


/**
 * Delete old check data
 * @param {Object} stats - Statistics object to update
 */
const deleteOldCheckData = async (stats) => {
    try {
        // Calculate retention date (7 days ago)
        const retentionDate = new Date();
        retentionDate.setDate(retentionDate.getDate() - 7);
        const retentionDateStr = retentionDate.toISOString().split('T')[0];

        logger.info(`Deleting check data older than: ${retentionDateStr}`);

        // Delete old checks in batches to avoid memory issues
        const batchSize = 1000;
        let deleted = 0;
        let hasMore = true;

        while (hasMore) {
            const result = await ServerCheck.deleteMany({
                date: { $lt: retentionDateStr }
            }).limit(batchSize);

            if (result.deletedCount === 0) {
                hasMore = false;
            } else {
                deleted += result.deletedCount;
                await new Promise(resolve => setTimeout(resolve, 100)); // Short pause between batches
            }
        }

        stats.checksDeleted = deleted;
        logger.info(`Deleted ${deleted} old checks`);
    } catch (error) {
        logger.error(`Error deleting old check data: ${error.message}`);
        throw error;
    }
};

/**
 * Delete old cron job logs
 * @param {Object} stats - Statistics object to update
 */
const deleteOldCronJobLogs = async (stats) => {
    try {
        // Calculate retention date (30 days ago)
        const retentionDate = new Date();
        retentionDate.setDate(retentionDate.getDate() - 30);

        logger.info(`Deleting cron job logs older than: ${retentionDate.toISOString()}`);

        // Delete old cron job logs
        const result = await CronJob.deleteMany({
            startedAt: { $lt: retentionDate }
        });

        stats.jobLogsDeleted = result.deletedCount;
        logger.info(`Deleted ${result.deletedCount} old cron job logs`);
    } catch (error) {
        logger.error(`Error deleting old cron job logs: ${error.message}`);
        throw error;
    }
};

export default { runDataRetention };