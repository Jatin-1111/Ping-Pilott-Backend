// controllers/analyticsController.js

import moment from 'moment-timezone';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Server from '../models/Server.js';
import ServerCheck from '../models/ServerCheck.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import logger from '../utils/logger.js';

/**
 * @desc    Get admin dashboard analytics data
 * @route   GET /api/admin/analytics
 * @access  Private/Admin
 */
export const getAnalytics = asyncHandler(async (req, res) => {
    // Get query parameters
    const {
        startDate,
        endDate,
        prevStartDate,
        prevEndDate,
        period = 'month' // Default to month
    } = req.query;

    // Validate dates
    const start = startDate ? new Date(startDate) : moment().subtract(30, 'days').toDate();
    const end = endDate ? new Date(endDate) : new Date();
    const prevStart = prevStartDate ? new Date(prevStartDate) : moment(start).subtract(30, 'days').toDate();
    const prevEnd = prevEndDate ? new Date(prevEndDate) : moment(start).subtract(1, 'milliseconds').toDate();

    try {
        // Run all data gathering operations in parallel for efficiency
        const [
            userStats,
            serverStats,
            alertStats,
            responseTimeStats,
            kpiStats
        ] = await Promise.all([
            getUserGrowthData(start, end, period),
            getServerStatusData(),
            getAlertsByTypeData(),
            getResponseTimeData(start, end, period),
            getKPIData(start, end, prevStart, prevEnd)
        ]);

        // Combine all data
        const analyticsData = {
            userGrowth: userStats,
            serverStatus: serverStats,
            alertsByType: alertStats,
            responseTime: responseTimeStats,
            kpis: kpiStats
        };

        res.status(200).json({
            status: 'success',
            message: 'Analytics data retrieved successfully',
            data: analyticsData
        });

    } catch (error) {
        logger.error(`Error retrieving analytics data: ${error.message}`);
        res.status(500).json({
            status: 'error',
            message: 'Failed to retrieve analytics data',
            error: error.message
        });
    }
});

/**
 * Get user growth data
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @param {String} period - Time period ('week', 'month', 'year')
 * @returns {Array} User growth data
 */
const getUserGrowthData = async (startDate, endDate, period) => {
    // Determine date format and grouping based on period
    let dateFormat, groupBy;

    switch (period) {
        case 'week':
            dateFormat = '%Y-%m-%d'; // Daily for week
            groupBy = { day: { $dayOfMonth: '$createdAt' }, month: { $month: '$createdAt' }, year: { $year: '$createdAt' } };
            break;
        case 'month':
            dateFormat = '%Y-%m-%d'; // Daily for month
            groupBy = { day: { $dayOfMonth: '$createdAt' }, month: { $month: '$createdAt' }, year: { $year: '$createdAt' } };
            break;
        case 'year':
            dateFormat = '%Y-%m'; // Monthly for year
            groupBy = { month: { $month: '$createdAt' }, year: { $year: '$createdAt' } };
            break;
        default:
            dateFormat = '%Y-%m-%d';
            groupBy = { day: { $dayOfMonth: '$createdAt' }, month: { $month: '$createdAt' }, year: { $year: '$createdAt' } };
    }

    // Aggregate users by creation date
    const userGrowth = await User.aggregate([
        {
            $match: {
                createdAt: { $gte: startDate, $lte: endDate }
            }
        },
        {
            $group: {
                _id: groupBy,
                users: { $sum: 1 }
            }
        },
        {
            $sort: {
                '_id.year': 1,
                '_id.month': 1,
                '_id.day': 1
            }
        },
        {
            $project: {
                _id: 0,
                date: {
                    $dateToString: {
                        format: dateFormat,
                        date: {
                            $dateFromParts: {
                                year: '$_id.year',
                                month: '$_id.month',
                                day: { $ifNull: ['$_id.day', 1] }
                            }
                        }
                    }
                },
                users: 1
            }
        }
    ]);

    // Format data for charts
    return userGrowth.map(item => ({
        name: item.date,
        users: item.users
    }));
};

/**
 * Get server status data
 * @returns {Array} Server status data
 */
const getServerStatusData = async () => {
    // Aggregate servers by status
    const serverStatusCount = await Server.aggregate([
        {
            $group: {
                _id: '$status',
                value: { $sum: 1 }
            }
        },
        {
            $project: {
                _id: 0,
                name: { $toUpper: '$_id' },
                value: 1
            }
        }
    ]);

    // If there's no 'down' status, add it with 0
    if (!serverStatusCount.some(item => item.name === 'DOWN')) {
        serverStatusCount.push({ name: 'DOWN', value: 0 });
    }

    // If there's no 'up' status, add it with 0
    if (!serverStatusCount.some(item => item.name === 'UP')) {
        serverStatusCount.push({ name: 'UP', value: 0 });
    }

    return serverStatusCount;
};

/**
 * Get alerts by type data
 * @returns {Array} Alerts by type data
 */
const getAlertsByTypeData = async () => {
    // Get servers with errors
    const serversWithErrors = await Server.find({
        $or: [
            { status: 'down' },
            { error: { $ne: null } }
        ]
    });

    // Categorize alerts by error type
    const alertsByType = {
        'Response Time': 0,
        'Connection Failed': 0,
        'Certificate Error': 0,
        'DNS Error': 0,
        'Other': 0
    };

    serversWithErrors.forEach(server => {
        const errorMessage = server.error || '';

        if (errorMessage.includes('timeout') || errorMessage.includes('slow') || errorMessage.includes('response')) {
            alertsByType['Response Time']++;
        } else if (errorMessage.includes('connect') || errorMessage.includes('refused')) {
            alertsByType['Connection Failed']++;
        } else if (errorMessage.includes('certificate') || errorMessage.includes('SSL')) {
            alertsByType['Certificate Error']++;
        } else if (errorMessage.includes('DNS') || errorMessage.includes('resolve')) {
            alertsByType['DNS Error']++;
        } else if (server.status === 'down' || errorMessage) {
            alertsByType['Other']++;
        }
    });

    // Format data for charts
    return Object.keys(alertsByType).map(type => ({
        name: type,
        value: alertsByType[type]
    }));
};

/**
 * Get response time data
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @param {String} period - Time period ('week', 'month', 'year')
 * @returns {Array} Response time data
 */
const getResponseTimeData = async (startDate, endDate, period) => {
    // Determine time grouping based on period
    let timeField, timeFormat;

    switch (period) {
        case 'week':
            timeField = { $dateToString: { format: '%H:00', date: '$timestamp' } };
            timeFormat = '%H:00';
            break;
        case 'month':
            timeField = {
                $concat: [
                    { $toString: { $dayOfMonth: '$timestamp' } },
                    ' ',
                    { $dateToString: { format: '%b', date: '$timestamp' } },
                    ' ',
                    { $dateToString: { format: '%H:00', date: '$timestamp' } }
                ]
            };
            timeFormat = '%d %b %H:00';
            break;
        case 'year':
            timeField = { $dateToString: { format: '%b %Y', date: '$timestamp' } };
            timeFormat = '%b %Y';
            break;
        default:
            timeField = { $dateToString: { format: '%H:00', date: '$timestamp' } };
            timeFormat = '%H:00';
    }

    // Aggregate check data by time period and average response time
    const responseTimeData = await ServerCheck.aggregate([
        {
            $match: {
                timestamp: { $gte: startDate, $lte: endDate },
                status: 'up' // Only consider successful checks
            }
        },
        {
            $group: {
                _id: timeField,
                avgTime: { $avg: '$responseTime' }
            }
        },
        {
            $sort: { '_id': 1 }
        },
        {
            $project: {
                _id: 0,
                name: '$_id',
                avgTime: { $round: ['$avgTime', 0] } // Round to whole number
            }
        }
    ]);

    return responseTimeData;
};

/**
 * Get KPI data
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @param {Date} prevStartDate - Previous period start date
 * @param {Date} prevEndDate - Previous period end date
 * @returns {Object} KPI data
 */
const getKPIData = async (startDate, endDate, prevStartDate, prevEndDate) => {
    // Current period stats
    const [
        currentUsers,
        currentServers,
        currentAvgResponseTime,
        currentUptime
    ] = await Promise.all([
        User.countDocuments({ createdAt: { $lte: endDate } }),
        Server.countDocuments({ createdAt: { $lte: endDate } }),
        getAverageResponseTime(startDate, endDate),
        getUptimePercentage(startDate, endDate)
    ]);

    // Previous period stats
    const [
        prevUsers,
        prevServers,
        prevAvgResponseTime,
        prevUptime
    ] = await Promise.all([
        User.countDocuments({ createdAt: { $lte: prevEndDate } }),
        Server.countDocuments({ createdAt: { $lte: prevEndDate } }),
        getAverageResponseTime(prevStartDate, prevEndDate),
        getUptimePercentage(prevStartDate, prevEndDate)
    ]);

    // Calculate changes
    const calculateChange = (current, previous) => {
        if (previous === 0) return previous === current ? 0 : 100;
        return ((current - previous) / previous) * 100;
    };

    const usersChange = calculateChange(currentUsers, prevUsers);
    const serversChange = calculateChange(currentServers, prevServers);
    const responseTimeChange = calculateChange(currentAvgResponseTime, prevAvgResponseTime);
    const uptimeChange = calculateChange(currentUptime, prevUptime);

    return {
        avgResponseTime: Math.round(currentAvgResponseTime),
        uptime: parseFloat(currentUptime.toFixed(1)),
        activeServers: currentServers,
        activeUsers: currentUsers,
        responseTimeChange: responseTimeChange.toFixed(0),
        uptimeChange: uptimeChange.toFixed(1),
        serversChange: serversChange.toFixed(0),
        usersChange: usersChange.toFixed(0)
    };
};

/**
 * Get average response time for a time period
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Number} Average response time
 */
const getAverageResponseTime = async (startDate, endDate) => {
    const result = await ServerCheck.aggregate([
        {
            $match: {
                timestamp: { $gte: startDate, $lte: endDate },
                status: 'up'
            }
        },
        {
            $group: {
                _id: null,
                avgResponseTime: { $avg: '$responseTime' }
            }
        }
    ]);

    return result.length > 0 ? result[0].avgResponseTime : 0;
};

/**
 * Get uptime percentage for a time period
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Number} Uptime percentage
 */
const getUptimePercentage = async (startDate, endDate) => {
    const checks = await ServerCheck.aggregate([
        {
            $match: {
                timestamp: { $gte: startDate, $lte: endDate }
            }
        },
        {
            $group: {
                _id: null,
                totalChecks: { $sum: 1 },
                upChecks: {
                    $sum: {
                        $cond: [{ $eq: ['$status', 'up'] }, 1, 0]
                    }
                }
            }
        }
    ]);

    if (checks.length === 0) return 100; // Default to 100% if no data

    const { totalChecks, upChecks } = checks[0];
    return (upChecks / totalChecks) * 100;
};

export default {
    getAnalytics
};