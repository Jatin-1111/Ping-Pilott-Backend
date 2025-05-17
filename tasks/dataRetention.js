import logger from '../utils/logger.js';
import ServerCheck from '../models/ServerCheck.js';
import ServerDailySummary from '../models/ServerDailySummary.js';
import CronJob from '../models/CronJob.js';

/**
 * Run data retention/cleanup process
 * Archives old check data and removes it from the active collection
 * @returns {Object} Statistics about the retention process
 */
export const runDataRetention = async () => {
    logger.info('Starting data retention process');

    const stats = {
        checksArchived: 0,
        checksDeleted: 0,
        jobLogsDeleted: 0
    };

    try {
        // Archive yesterday's checks
        await archiveYesterdayChecks(stats);

        // Delete old check data (older than 7 days)
        await deleteOldCheckData(stats);

        // Delete old cron job logs (older than 30 days)
        await deleteOldCronJobLogs(stats);

        logger.info('Data retention process completed successfully', { stats });
        return stats;
    } catch (error) {
        logger.error(`Error in data retention process: ${error.message}`);
        throw error;
    }
};

/**
 * Archive yesterday's check data into daily summaries
 * @param {Object} stats - Statistics object to update
 */
const archiveYesterdayChecks = async (stats) => {
    try {
        // Calculate yesterday's date
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        logger.info(`Archiving check data for date: ${yesterdayStr}`);

        // Get all server IDs that had checks yesterday
        const serverIds = await ServerCheck.distinct('serverId', { date: yesterdayStr });

        logger.info(`Found ${serverIds.length} servers with checks from yesterday`);

        // For each server, create a daily summary
        for (const serverId of serverIds) {
            // Get all checks for this server from yesterday
            const checks = await ServerCheck.find({
                serverId,
                date: yesterdayStr
            });

            if (checks.length === 0) continue;

            // Calculate daily statistics
            let totalResponseTime = 0;
            let totalChecks = 0;
            let upChecks = 0;
            let maxResponseTime = 0;
            let minResponseTime = Number.MAX_SAFE_INTEGER;

            checks.forEach(check => {
                if (check.responseTime) {
                    totalResponseTime += check.responseTime;
                    maxResponseTime = Math.max(maxResponseTime, check.responseTime);
                    minResponseTime = Math.min(minResponseTime, check.responseTime);
                    totalChecks++;

                    if (check.status === 'up') {
                        upChecks++;
                    }
                }
            });

            // Create or update the daily summary
            const existingSummary = await ServerDailySummary.findOne({
                serverId,
                date: yesterdayStr
            });

            if (existingSummary) {
                existingSummary.totalChecks = totalChecks;
                existingSummary.upChecks = upChecks;
                existingSummary.uptime = totalChecks > 0 ? (upChecks / totalChecks) * 100 : 0;
                existingSummary.avgResponseTime = totalChecks > 0 ? totalResponseTime / totalChecks : 0;
                existingSummary.maxResponseTime = maxResponseTime !== 0 ? maxResponseTime : null;
                existingSummary.minResponseTime = minResponseTime !== Number.MAX_SAFE_INTEGER ? minResponseTime : null;
                await existingSummary.save();
            } else {
                await ServerDailySummary.create({
                    serverId,
                    date: yesterdayStr,
                    totalChecks,
                    upChecks,
                    uptime: totalChecks > 0 ? (upChecks / totalChecks) * 100 : 0,
                    avgResponseTime: totalChecks > 0 ? totalResponseTime / totalChecks : 0,
                    maxResponseTime: maxResponseTime !== 0 ? maxResponseTime : null,
                    minResponseTime: minResponseTime !== Number.MAX_SAFE_INTEGER ? minResponseTime : null,
                    createdAt: new Date()
                });
            }

            stats.checksArchived += checks.length;
        }

        logger.info(`Archived ${stats.checksArchived} checks into daily summaries`);
    } catch (error) {
        logger.error(`Error archiving yesterday's checks: ${error.message}`);
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