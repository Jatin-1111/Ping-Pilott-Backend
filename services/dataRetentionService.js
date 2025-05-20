import logger from '../utils/logger.js';
import ServerCheck from '../models/ServerCheck.js';
import CronJob from '../models/CronJob.js';

/**
 * Clean up old monitoring data based on retention policies
 * @param {Number} checkDataDays - Number of days to keep individual check data
 * @param {Number} logRetentionDays - Number of days to keep cron job logs
 * @returns {Object} Statistics about the retention process
 */
export const cleanupOldData = async (
    checkDataDays = parseInt(process.env.CHECK_DATA_RETENTION_DAYS) || 7,
    logRetentionDays = parseInt(process.env.LOG_RETENTION_DAYS) || 30
) => {
    logger.info(`Starting data retention with check data: ${checkDataDays} days, logs: ${logRetentionDays} days`);

    const stats = {
        checksDeleted: 0,
        jobLogsDeleted: 0
    };

    try {
        // Calculate retention dates
        const checkRetentionDate = new Date();
        checkRetentionDate.setDate(checkRetentionDate.getDate() - checkDataDays);
        const checkRetentionDateStr = checkRetentionDate.toISOString().split('T')[0];

        const logRetentionDate = new Date();
        logRetentionDate.setDate(logRetentionDate.getDate() - logRetentionDays);

        // Delete old check data
        const checkResult = await ServerCheck.deleteMany({
            date: { $lt: checkRetentionDateStr }
        });

        stats.checksDeleted = checkResult.deletedCount;
        logger.info(`Deleted ${checkResult.deletedCount} old check records`);

        // Delete old cron job logs
        const jobLogResult = await CronJob.deleteMany({
            startedAt: { $lt: logRetentionDate }
        });

        stats.jobLogsDeleted = jobLogResult.deletedCount;
        logger.info(`Deleted ${jobLogResult.deletedCount} old cron job logs`);

        logger.info('Data retention process completed successfully', { stats });
        return stats;
    } catch (error) {
        logger.error(`Error in data retention process: ${error.message}`);
        throw error;
    }
};

export default {
    cleanupOldData,
};