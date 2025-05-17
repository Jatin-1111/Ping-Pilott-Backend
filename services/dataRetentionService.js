import logger from '../utils/logger.js';
import ServerCheck from '../models/ServerCheck.js';
import ServerDailySummary from '../models/ServerDailySummary.js';
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

/**
 * Archive individual check data into daily summaries
 * @param {String} date - Date to archive in YYYY-MM-DD format
 * @returns {Object} Statistics about the archiving process
 */
export const archiveDailyChecks = async (date) => {
    logger.info(`Archiving check data for date: ${date}`);

    const stats = {
        serversArchived: 0,
        checksArchived: 0
    };

    try {
        // Get all server IDs that had checks on the specified date
        const serverIds = await ServerCheck.distinct('serverId', { date });

        logger.info(`Found ${serverIds.length} servers with checks on ${date}`);

        // For each server, create a daily summary
        for (const serverId of serverIds) {
            // Get all checks for this server from the specified date
            const checks = await ServerCheck.find({
                serverId,
                date
            });

            if (checks.length === 0) continue;

            // Calculate daily statistics
            let totalResponseTime = 0;
            let totalChecks = 0;
            let upChecks = 0;
            let maxResponseTime = 0;
            let minResponseTime = Number.MAX_SAFE_INTEGER;

            checks.forEach(check => {
                totalChecks++;

                if (check.status === 'up') {
                    upChecks++;

                    if (check.responseTime) {
                        totalResponseTime += check.responseTime;
                        maxResponseTime = Math.max(maxResponseTime, check.responseTime);
                        minResponseTime = Math.min(minResponseTime, check.responseTime);
                    }
                }
            });

            // Create or update the daily summary
            const existingSummary = await ServerDailySummary.findOne({
                serverId,
                date
            });

            if (existingSummary) {
                existingSummary.totalChecks = totalChecks;
                existingSummary.upChecks = upChecks;
                existingSummary.uptime = totalChecks > 0 ? (upChecks / totalChecks) * 100 : 0;
                existingSummary.avgResponseTime = upChecks > 0 ? totalResponseTime / upChecks : null;
                existingSummary.maxResponseTime = maxResponseTime !== 0 ? maxResponseTime : null;
                existingSummary.minResponseTime = minResponseTime !== Number.MAX_SAFE_INTEGER ? minResponseTime : null;
                await existingSummary.save();
            } else {
                await ServerDailySummary.create({
                    serverId,
                    date,
                    totalChecks,
                    upChecks,
                    uptime: totalChecks > 0 ? (upChecks / totalChecks) * 100 : 0,
                    avgResponseTime: upChecks > 0 ? totalResponseTime / upChecks : null,
                    maxResponseTime: maxResponseTime !== 0 ? maxResponseTime : null,
                    minResponseTime: minResponseTime !== Number.MAX_SAFE_INTEGER ? minResponseTime : null,
                    createdAt: new Date()
                });
            }

            stats.checksArchived += checks.length;
            stats.serversArchived++;
        }

        logger.info(`Archived ${stats.checksArchived} checks for ${stats.serversArchived} servers`);
        return stats;
    } catch (error) {
        logger.error(`Error archiving daily checks: ${error.message}`);
        throw error;
    }
};

export default {
    cleanupOldData,
    archiveDailyChecks
};