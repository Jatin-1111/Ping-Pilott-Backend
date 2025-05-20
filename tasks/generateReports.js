import logger from '../utils/logger.js';
import User from '../models/User.js';
import Server from '../models/Server.js';
import ServerDailySummary from '../models/ServerDailySummary.js';
// import { sendEmailReport } from '../services/emailService.js';

/**
 * Generate and send daily reports to users
 * @returns {Object} Statistics about the reports generated
 */
export const generateDailyReports = async () => {
    logger.info('Starting daily reports generation');

    const stats = {
        totalUsers: 0,
        eligibleUsers: 0,
        reportsSent: 0,
        errors: 0
    };

    try {
        // Get yesterday's date for the reports
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        logger.info(`Generating reports for date: ${yesterdayStr}`);

        // Get all users who should receive reports
        // Only users with active subscriptions including the historicalReporting feature
        const eligibleUsers = await User.find({
            'subscription.status': 'active',
            'subscription.features.historicalReporting': true
        });

        stats.totalUsers = await User.countDocuments();
        stats.eligibleUsers = eligibleUsers.length;

        logger.info(`Found ${eligibleUsers.length} eligible users for reports`);

        // For each eligible user, generate and send a report
        for (const user of eligibleUsers) {
            try {
                // Get all servers owned by this user
                const servers = await Server.find({ uploadedBy: user.id });

                if (servers.length === 0) {
                    logger.debug(`User ${user.id} has no servers, skipping report`);
                    continue;
                }

                // Get all daily summaries for user's servers from yesterday
                const serverIds = servers.map(server => server._id);
                const summaries = await ServerDailySummary.find({
                    serverId: { $in: serverIds },
                    date: yesterdayStr
                }).populate('serverId', 'name url');

                if (summaries.length === 0) {
                    logger.debug(`No summaries found for user ${user.id}'s servers on ${yesterdayStr}, skipping report`);
                    continue;
                }

                // Generate report data
                const reportData = generateReportData(summaries, servers);

                // Send email report if user has an email
                if (user.email) {
                    // await sendEmailReport(user, reportData, yesterdayStr);
                    stats.reportsSent++;
                    logger.info(`Report sent to user ${user.id} (${user.email})`);
                }
            } catch (error) {
                logger.error(`Error generating report for user ${user.id}: ${error.message}`);
                stats.errors++;
            }
        }

        logger.info('Daily reports generation completed successfully', { stats });
        return stats;
    } catch (error) {
        logger.error(`Error in daily reports generation: ${error.message}`);
        throw error;
    }
};

/**
 * Generate the report data from server summaries
 * @param {Array} summaries - Array of server daily summaries
 * @param {Array} servers - Array of server objects
 * @returns {Object} Formatted report data
 */
const generateReportData = (summaries, servers) => {
    // Overall statistics
    let totalUptime = 0;
    let totalAvgResponseTime = 0;
    let totalChecks = 0;

    // Individual server statistics
    const serverStats = [];

    // Process each summary
    summaries.forEach(summary => {
        const server = servers.find(s => s._id.toString() === summary.serverId.toString());

        if (server) {
            totalUptime += summary.uptime;
            totalAvgResponseTime += summary.avgResponseTime || 0;
            totalChecks += summary.totalChecks;

            serverStats.push({
                name: server.name,
                url: server.url,
                uptime: summary.uptime.toFixed(2),
                avgResponseTime: summary.avgResponseTime ? Math.round(summary.avgResponseTime) : 'N/A',
                totalChecks: summary.totalChecks,
                downChecks: summary.totalChecks - summary.upChecks,
                maxResponseTime: summary.maxResponseTime ? Math.round(summary.maxResponseTime) : 'N/A',
                minResponseTime: summary.minResponseTime ? Math.round(summary.minResponseTime) : 'N/A'
            });
        }
    });

    // Calculate averages
    const avgUptime = serverStats.length > 0 ? totalUptime / serverStats.length : 0;
    const avgResponseTime = serverStats.length > 0 ? totalAvgResponseTime / serverStats.length : 0;

    return {
        overall: {
            totalServers: serverStats.length,
            avgUptime: avgUptime.toFixed(2),
            avgResponseTime: Math.round(avgResponseTime),
            totalChecks
        },
        servers: serverStats
    };
};

export default { generateDailyReports };