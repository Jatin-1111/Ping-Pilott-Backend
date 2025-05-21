// controllers/analyticsController.js - Optimized for performance

import moment from 'moment-timezone';
import User from '../models/User.js';
import Server from '../models/Server.js';
import ServerCheck from '../models/ServerCheck.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import logger from '../utils/logger.js';

// Cache for analytics data with configurable TTL
const analyticsCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

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
        period = 'month', // Default to month
        useCache = 'true'  // Allow cache bypass with query param
    } = req.query;

    // Validate dates
    const start = startDate ? new Date(startDate) : moment().subtract(30, 'days').toDate();
    const end = endDate ? new Date(endDate) : new Date();
    const prevStart = prevStartDate ? new Date(prevStartDate) : moment(start).subtract(30, 'days').toDate();
    const prevEnd = prevEndDate ? new Date(prevEndDate) : moment(start).subtract(1, 'milliseconds').toDate();

    // Generate cache key based on request parameters
    const cacheKey = `analytics:${period}:${start.getTime()}:${end.getTime()}:${prevStart.getTime()}:${prevEnd.getTime()}`;

    // Check cache if enabled
    if (useCache === 'true' && analyticsCache.has(cacheKey)) {
        const cachedData = analyticsCache.get(cacheKey);
        if (cachedData.timestamp > Date.now() - CACHE_TTL) {
            return res.status(200).json({
                status: 'success',
                message: 'Analytics data retrieved from cache',
                data: cachedData.data,
                cached: true
            });
        }
        analyticsCache.delete(cacheKey); // Clear expired cache
    }

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

        // Store in cache
        analyticsCache.set(cacheKey, {
            timestamp: Date.now(),
            data: analyticsData
        });

        // Manage cache size (prevent memory leaks)
        if (analyticsCache.size > 100) {
            // Clear oldest entries if cache gets too large
            const cacheEntries = [...analyticsCache.entries()];
            cacheEntries.sort((a, b) => a[1].timestamp - b[1].timestamp);
            for (let i = 0; i < 20; i++) {
                analyticsCache.delete(cacheEntries[i][0]);
            }
        }

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
 * Get user growth data with optimized query
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @param {String} period - Time period ('week', 'month', 'year')
 * @returns {Array} User growth data
 */
const getUserGrowthData = async (startDate, endDate, period) => {
    // Optimize query based on period - select only necessary fields and use indexing effectively
    let groupBy, dateFormat;

    switch (period) {
        case 'year':
            groupBy = {
                year: { $year: '$createdAt' },
                month: { $month: '$createdAt' }
            };
            dateFormat = '%Y-%m';
            break;
        case 'week':
        case 'month':
        default:
            groupBy = {
                year: { $year: '$createdAt' },
                month: { $month: '$createdAt' },
                day: { $dayOfMonth: '$createdAt' }
            };
            dateFormat = '%Y-%m-%d';
    }

    // Optimize: Use lean queries for better performance
    const pipeline = [
        {
            $match: {
                createdAt: { $gte: startDate, $lte: endDate }
            }
        },
        {
            $project: {
                // Only select the necessary field for better performance
                createdAt: 1
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
    ];

    // Execute the optimized aggregation
    const userGrowth = await User.aggregate(pipeline).allowDiskUse(true);

    // Use more efficient map function
    return userGrowth.map(item => ({
        name: item.date,
        users: item.users
    }));
};

/**
 * Get server status data with optimized query
 * @returns {Array} Server status data
 */
const getServerStatusData = async () => {
    // More efficient query by using a simpler pipeline and projection
    const statuses = ['up', 'down', 'unknown'];
    const counts = {};

    // Get counts of each status
    const statusCounts = await Server.aggregate([
        {
            $group: {
                _id: '$status',
                count: { $sum: 1 }
            }
        }
    ]);

    // Initialize all possible statuses with 0
    statuses.forEach(status => {
        counts[status.toUpperCase()] = 0;
    });

    // Update counts with actual data
    statusCounts.forEach(item => {
        if (item._id) {
            counts[item._id.toUpperCase()] = item.count;
        }
    });

    // Convert to required format
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
};

/**
 * Get alerts by type data with optimized query
 * @returns {Array} Alerts by type data
 */
const getAlertsByTypeData = async () => {
    // Original query is inefficient due to client-side processing - optimize with server aggregation
    // Use a more efficient pipeline that processes on the database side
    const alertTypes = [
        { pattern: /timeout|slow|response/i, name: 'Response Time' },
        { pattern: /connect|refused/i, name: 'Connection Failed' },
        { pattern: /certificate|SSL/i, name: 'Certificate Error' },
        { pattern: /DNS|resolve/i, name: 'DNS Error' }
    ];

    // Convert patterns to MongoDB's $regex expressions for pipeline
    const regexConditions = alertTypes.map(type => ({
        name: type.name,
        condition: { $regexMatch: { input: { $ifNull: ['$error', ''] }, regex: type.pattern.source, options: 'i' } }
    }));

    // Build pipeline using $cond expressions
    const pipeline = [
        {
            $match: {
                $or: [
                    { status: 'down' },
                    { error: { $ne: null } }
                ]
            }
        },
        {
            $project: {
                errorType: {
                    $switch: {
                        branches: regexConditions.map(condition => ({
                            case: condition.condition,
                            then: condition.name
                        })),
                        default: 'Other'
                    }
                }
            }
        },
        {
            $group: {
                _id: '$errorType',
                value: { $sum: 1 }
            }
        },
        {
            $project: {
                _id: 0,
                name: '$_id',
                value: 1
            }
        }
    ];

    // Execute optimized pipeline
    const results = await Server.aggregate(pipeline);

    // Ensure all error types exist in results with at least 0 value
    const alertCounts = {};

    // Initialize with zeros
    [...alertTypes.map(t => t.name), 'Other'].forEach(type => {
        alertCounts[type] = 0;
    });

    // Update with actual counts
    results.forEach(item => {
        alertCounts[item.name] = item.value;
    });

    // Convert to array format
    return Object.entries(alertCounts).map(([name, value]) => ({ name, value }));
};

/**
 * Get response time data with optimized query
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @param {String} period - Time period ('week', 'month', 'year')
 * @returns {Array} Response time data
 */
const getResponseTimeData = async (startDate, endDate, period) => {
    // Optimize time fields based on period
    let groupByTime;

    switch (period) {
        case 'week':
            groupByTime = {
                hour: { $hour: '$timestamp' }
            };
            break;
        case 'month':
            groupByTime = {
                day: { $dayOfMonth: '$timestamp' },
                hour: { $hour: '$timestamp' }
            };
            break;
        case 'year':
            groupByTime = {
                month: { $month: '$timestamp' },
                year: { $year: '$timestamp' }
            };
            break;
        default:
            groupByTime = {
                hour: { $hour: '$timestamp' }
            };
    }

    // Create pipeline with optimal stages and field selection
    const pipeline = [
        {
            $match: {
                timestamp: { $gte: startDate, $lte: endDate },
                status: 'up'
            }
        },
        {
            $project: {
                timestamp: 1,
                responseTime: 1
            }
        },
        {
            $group: {
                _id: groupByTime,
                avgTime: { $avg: '$responseTime' }
            }
        },
        {
            $sort: {
                '_id.year': 1,
                '_id.month': 1,
                '_id.day': 1,
                '_id.hour': 1
            }
        }
    ];

    // Define formatting function based on period
    let formatName;

    switch (period) {
        case 'week':
            formatName = (id) => `${id.hour}:00`;
            break;
        case 'month':
            formatName = (id) => `${id.day} ${id.hour}:00`;
            break;
        case 'year':
            formatName = (id) => {
                const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                return `${monthNames[id.month - 1]} ${id.year}`;
            };
            break;
        default:
            formatName = (id) => `${id.hour}:00`;
    }

    // Execute optimized pipeline
    const responseTimeData = await ServerCheck.aggregate(pipeline);

    // Format results client-side (more efficiently than complex $project)
    return responseTimeData.map(item => ({
        name: formatName(item._id),
        avgTime: Math.round(item.avgTime || 0)
    }));
};

/**
 * Get KPI data with optimized queries
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @param {Date} prevStartDate - Previous period start date
 * @param {Date} prevEndDate - Previous period end date
 * @returns {Object} KPI data
 */
const getKPIData = async (startDate, endDate, prevStartDate, prevEndDate) => {
    // Optimize: Reduce number of queries by combining them where possible

    // Get current and previous data in single queries where possible
    const [userCounts, serverCounts, responseTimesData, uptimeData] = await Promise.all([
        // User counts - single query for both periods
        User.aggregate([
            {
                $group: {
                    _id: null,
                    currentUsers: {
                        $sum: { $cond: [{ $lte: ['$createdAt', endDate] }, 1, 0] }
                    },
                    prevUsers: {
                        $sum: { $cond: [{ $lte: ['$createdAt', prevEndDate] }, 1, 0] }
                    }
                }
            }
        ]),

        // Server counts - single query for both periods
        Server.aggregate([
            {
                $group: {
                    _id: null,
                    currentServers: {
                        $sum: { $cond: [{ $lte: ['$createdAt', endDate] }, 1, 0] }
                    },
                    prevServers: {
                        $sum: { $cond: [{ $lte: ['$createdAt', prevEndDate] }, 1, 0] }
                    }
                }
            }
        ]),

        // Response times - need separate time periods
        Promise.all([
            getAverageResponseTime(startDate, endDate),
            getAverageResponseTime(prevStartDate, prevEndDate)
        ]),

        // Uptime data - need separate time periods
        Promise.all([
            getUptimePercentage(startDate, endDate),
            getUptimePercentage(prevStartDate, prevEndDate)
        ])
    ]);

    // Extract values from query results with safe defaults
    const currentUsers = userCounts.length > 0 ? userCounts[0].currentUsers : 0;
    const prevUsers = userCounts.length > 0 ? userCounts[0].prevUsers : 0;

    const currentServers = serverCounts.length > 0 ? serverCounts[0].currentServers : 0;
    const prevServers = serverCounts.length > 0 ? serverCounts[0].prevServers : 0;

    const [currentAvgResponseTime, prevAvgResponseTime] = responseTimesData;
    const [currentUptime, prevUptime] = uptimeData;

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
 * Get average response time for a time period with optimized query
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Number} Average response time
 */
const getAverageResponseTime = async (startDate, endDate) => {
    // Optimized pipeline with proper field selection
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
 * Get uptime percentage for a time period with optimized query
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Number} Uptime percentage
 */
const getUptimePercentage = async (startDate, endDate) => {
    // More efficient pipeline using proper field selection
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

// Cache cleanup system
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of analyticsCache.entries()) {
        if (value.timestamp < now - CACHE_TTL) {
            analyticsCache.delete(key);
        }
    }
}, 60000); // Run cleanup every minute

export default {
    getAnalytics
};