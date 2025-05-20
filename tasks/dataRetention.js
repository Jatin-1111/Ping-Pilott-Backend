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
        checksDeleted: 0,
        jobLogsDeleted: 0
    };

    try {
        // First, get count of records before deletion for comparison
        const checkCountBefore = await ServerCheck.countDocuments();
        const jobCountBefore = await CronJob.countDocuments();

        // Calculate yesterday's date
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        logger.info(`Deleting all check data for date: ${yesterdayStr}`);

        // Get sample of records to be deleted for verification
        const recordsToDelete = await ServerCheck.find({ date: { $lte: yesterdayStr } }).limit(5);

        // Delete all of yesterday's checks
        const result = await ServerCheck.deleteMany({ date: { $lte: yesterdayStr } });

        stats.checksDeleted = result.deletedCount;
        logger.info(`Deleted ${result.deletedCount} checks from previous days`);

        // Calculate retention date for CronJob logs (30 days ago)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);


        // Get sample of job logs to be deleted for verification
        const jobLogsToDelete = await CronJob.find({ startedAt: { $lt: thirtyDaysAgo } }).limit(5);

        // Delete old cron job logs
        const jobResult = await CronJob.deleteMany({ startedAt: { $lt: thirtyDaysAgo } });

        stats.jobLogsDeleted = jobResult.deletedCount;
        logger.info(`Deleted ${jobResult.deletedCount} old cron job logs`);

        // Get count of records after deletion for verification
        const checkCountAfter = await ServerCheck.countDocuments();
        const jobCountAfter = await CronJob.countDocuments();

        logger.info('Data retention process completed successfully', { stats });
        return stats;
    } catch (error) {
        logger.error(`Error in data retention process: ${error.message}`);
        throw error;
    }
};

export default { runDataRetention };