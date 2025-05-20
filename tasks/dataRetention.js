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
    console.log('[TROUBLESHOOTING] Starting data retention process at', new Date().toISOString());

    const stats = {
        checksDeleted: 0,
        jobLogsDeleted: 0
    };

    try {
        // First, get count of records before deletion for comparison
        const checkCountBefore = await ServerCheck.countDocuments();
        const jobCountBefore = await CronJob.countDocuments();

        console.log(`[TROUBLESHOOTING] Before deletion: ServerCheck records: ${checkCountBefore}, CronJob records: ${jobCountBefore}`);

        // Calculate yesterday's date
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        logger.info(`Deleting all check data for date: ${yesterdayStr}`);
        console.log(`[TROUBLESHOOTING] Deleting all check data for date: ${yesterdayStr}`);

        // Get sample of records to be deleted for verification
        const recordsToDelete = await ServerCheck.find({ date: { $lte: yesterdayStr } }).limit(5);
        console.log(`[TROUBLESHOOTING] Sample records to be deleted:`,
            recordsToDelete.map(r => ({ id: r._id, date: r.date, serverId: r.serverId })));

        // Delete all of yesterday's checks
        const result = await ServerCheck.deleteMany({ date: { $lte: yesterdayStr } });

        stats.checksDeleted = result.deletedCount;
        logger.info(`Deleted ${result.deletedCount} checks from previous days`);
        console.log(`[TROUBLESHOOTING] Deleted ${result.deletedCount} checks from previous days`);

        // Calculate retention date for CronJob logs (30 days ago)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        console.log(`[TROUBLESHOOTING] Deleting CronJob logs older than: ${thirtyDaysAgo.toISOString()}`);

        // Get sample of job logs to be deleted for verification
        const jobLogsToDelete = await CronJob.find({ startedAt: { $lt: thirtyDaysAgo } }).limit(5);
        console.log(`[TROUBLESHOOTING] Sample job logs to be deleted:`,
            jobLogsToDelete.map(j => ({ id: j._id, name: j.name, startedAt: j.startedAt })));

        // Delete old cron job logs
        const jobResult = await CronJob.deleteMany({ startedAt: { $lt: thirtyDaysAgo } });

        stats.jobLogsDeleted = jobResult.deletedCount;
        logger.info(`Deleted ${jobResult.deletedCount} old cron job logs`);
        console.log(`[TROUBLESHOOTING] Deleted ${jobResult.deletedCount} old cron job logs`);

        // Get count of records after deletion for verification
        const checkCountAfter = await ServerCheck.countDocuments();
        const jobCountAfter = await CronJob.countDocuments();

        console.log(`[TROUBLESHOOTING] After deletion: ServerCheck records: ${checkCountAfter}, CronJob records: ${jobCountAfter}`);
        console.log(`[TROUBLESHOOTING] Deleted ${checkCountBefore - checkCountAfter} ServerCheck records and ${jobCountBefore - jobCountAfter} CronJob records`);

        logger.info('Data retention process completed successfully', { stats });
        console.log('[TROUBLESHOOTING] Data retention process completed successfully', JSON.stringify(stats));
        return stats;
    } catch (error) {
        logger.error(`Error in data retention process: ${error.message}`);
        console.error(`[TROUBLESHOOTING] Error in data retention process: ${error.message}`);
        console.error('[TROUBLESHOOTING] Error stack:', error.stack);
        throw error;
    }
};

export default { runDataRetention };