// controllers/analyticsController.js - OPTIMIZED FOR SPEED ⚡

import mongoose from 'mongoose';
import User from '../models/User.js';
import Server from '../models/Server.js';
import ServerCheck from '../models/ServerCheck.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import logger from '../utils/logger.js';

/**
 * @desc    Get admin dashboard analytics data - OPTIMIZED
 * @route   GET /api/admin/analytics
 * @access  Private/Admin
 */
export const getAnalytics = asyncHandler(async (req, res) => {
    const startTime = Date.now();

    // Parse and validate date parameters
    const {
        startDate,
        endDate,
        prevStartDate,
        prevEndDate,
        period = 'month'
    } = req.query;

    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();
    const prevStart = prevStartDate ? new Date(prevStartDate) : new Date(start.getTime() - 30 * 24 * 60 * 60 * 1000);
    const prevEnd = prevEndDate ? new Date(prevEndDate) : new Date(start.getTime() - 1);

    try {
        logger.info(`🚀 Starting analytics query for period: ${period}`);

        // Execute ALL analytics queries in parallel - maximum speed
        const [
            userStats,
            serverStats,
            alertStats,
            responseTimeStats,
            kpiStats
        ] = await Promise.all([
            getUserGrowthOptimized(start, end, period),
            getServerStatusOptimized(),
            getAlertsByTypeOptimized(),
            getResponseTimeOptimized(start, end, period),
            getKPIsOptimized(start, end, prevStart, prevEnd)
        ]);

        const analyticsData = {
            userGrowth: userStats,
            serverStatus: serverStats,
            alertsByType: alertStats,
            responseTime: responseTimeStats,
            kpis: kpiStats,
            meta: {
                queryTime: Date.now() - startTime,
                period,
                dateRange: { start, end }
            }
        };

        logger.info(`✅ Analytics completed in ${Date.now() - startTime}ms`);

        res.status(200).json({
            status: 'success',
            message: 'Analytics data retrieved successfully',
            data: analyticsData
        });

    } catch (error) {
        logger.error(`❌ Analytics error: ${error.message}`);
        res.status(500).json({
            status: 'error',
            message: 'Failed to retrieve analytics data',
            error: error.message
        });
    }
});

/**
 * @desc    Get just KPI data
 * @route   GET /api/admin/analytics/kpi
 * @access  Private/Admin
 */
export const getAnalyticsKPIs = asyncHandler(async (req, res) => {
    const { startDate, endDate, prevStartDate, prevEndDate } = req.query;
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();
    const prevStart = prevStartDate ? new Date(prevStartDate) : new Date(start.getTime() - 30 * 24 * 60 * 60 * 1000);
    const prevEnd = prevEndDate ? new Date(prevEndDate) : new Date(start.getTime() - 1);

    const stats = await getKPIsOptimized(start, end, prevStart, prevEnd);

    res.status(200).json({ status: 'success', data: stats });
});

/**
 * @desc    Get user growth chart data
 * @route   GET /api/admin/analytics/users
 * @access  Private/Admin
 */
export const getAnalyticsUserGrowth = asyncHandler(async (req, res) => {
    const { startDate, endDate, period = 'month' } = req.query;
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    const stats = await getUserGrowthOptimized(start, end, period);

    res.status(200).json({ status: 'success', data: stats });
});

/**
 * @desc    Get server status breakdown
 * @route   GET /api/admin/analytics/servers
 * @access  Private/Admin
 */
export const getAnalyticsServerStatus = asyncHandler(async (req, res) => {
    const stats = await getServerStatusOptimized();
    res.status(200).json({ status: 'success', data: stats });
});

/**
 * @desc    Get alerts by type
 * @route   GET /api/admin/analytics/alerts
 * @access  Private/Admin
 */
export const getAnalyticsAlerts = asyncHandler(async (req, res) => {
    const stats = await getAlertsByTypeOptimized();
    res.status(200).json({ status: 'success', data: stats });
});

/**
 * @desc    Get response time chart
 * @route   GET /api/admin/analytics/response-time
 * @access  Private/Admin
 */
export const getAnalyticsResponseTime = asyncHandler(async (req, res) => {
    const { startDate, endDate, period = 'month' } = req.query;
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    const stats = await getResponseTimeOptimized(start, end, period);

    res.status(200).json({ status: 'success', data: stats });
});

/**
 * OPTIMIZED: User growth with minimal data transfer
 */
const getUserGrowthOptimized = async (startDate, endDate, period) => {
    let groupStage, dateFormat;

    // Optimize grouping based on period
    switch (period) {
        case 'week':
            groupStage = {
                $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
            };
            break;
        case 'year':
            groupStage = {
                $dateToString: { format: '%Y-%m', date: '$createdAt' }
            };
            break;
        default: // month
            groupStage = {
                $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
            };
    }

    const pipeline = [
        {
            $match: {
                createdAt: { $gte: startDate, $lte: endDate }
            }
        },
        {
            $group: {
                _id: groupStage,
                users: { $sum: 1 }
            }
        },
        {
            $sort: { '_id': 1 }
        },
        {
            $project: {
                _id: 0,
                name: '$_id',
                users: 1
            }
        }
    ];

    return await User.aggregate(pipeline).allowDiskUse(true);
};

/**
 * OPTIMIZED: Server status with single aggregation
 */
const getServerStatusOptimized = async () => {
    const pipeline = [
        {
            $group: {
                _id: '$status',
                count: { $sum: 1 }
            }
        },
        {
            $project: {
                _id: 0,
                name: { $toUpper: '$_id' },
                value: '$count'
            }
        }
    ];

    const results = await Server.aggregate(pipeline);

    // Ensure all statuses are represented
    const statusMap = { UP: 0, DOWN: 0, UNKNOWN: 0 };
    results.forEach(item => {
        statusMap[item.name] = item.value;
    });

    return Object.entries(statusMap).map(([name, value]) => ({ name, value }));
};

/**
 * OPTIMIZED: Alerts by type using efficient regex matching
 */
const getAlertsByTypeOptimized = async () => {
    const pipeline = [
        {
            $match: {
                $or: [
                    { status: 'down' },
                    { error: { $ne: null, $ne: '' } }
                ]
            }
        },
        {
            $addFields: {
                errorType: {
                    $switch: {
                        branches: [
                            {
                                case: { $regexMatch: { input: { $ifNull: ['$error', ''] }, regex: /timeout|slow|response/i } },
                                then: 'Response Time'
                            },
                            {
                                case: { $regexMatch: { input: { $ifNull: ['$error', ''] }, regex: /connect|refused/i } },
                                then: 'Connection Failed'
                            },
                            {
                                case: { $regexMatch: { input: { $ifNull: ['$error', ''] }, regex: /certificate|SSL/i } },
                                then: 'Certificate Error'
                            },
                            {
                                case: { $regexMatch: { input: { $ifNull: ['$error', ''] }, regex: /DNS|resolve/i } },
                                then: 'DNS Error'
                            }
                        ],
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

    const results = await Server.aggregate(pipeline);

    // Ensure all error types exist
    const errorTypes = ['Response Time', 'Connection Failed', 'Certificate Error', 'DNS Error', 'Other'];
    const errorMap = {};
    errorTypes.forEach(type => errorMap[type] = 0);

    results.forEach(item => {
        errorMap[item.name] = item.value;
    });

    return Object.entries(errorMap).map(([name, value]) => ({ name, value }));
};

/**
 * OPTIMIZED: Response time with smart sampling
 */
const getResponseTimeOptimized = async (startDate, endDate, period) => {
    let groupStage, sampleRate = 1;

    // Smart sampling based on period to avoid overloading
    switch (period) {
        case 'week':
            groupStage = { $hour: '$timestamp' };
            sampleRate = 1; // All data for week
            break;
        case 'month':
            groupStage = {
                year: { $year: '$timestamp' },
                month: { $month: '$timestamp' },
                day: { $dayOfMonth: '$timestamp' },
                hour: { $hour: '$timestamp' }
            };
            sampleRate = 0.5; // 50% sample for month
            break;
        case 'year':
            groupStage = {
                year: { $year: '$timestamp' },
                month: { $month: '$timestamp' }
            };
            sampleRate = 0.1; // 10% sample for year
            break;
        default:
            groupStage = { $hour: '$timestamp' };
            sampleRate = 1;
    }

    const pipeline = [
        {
            $match: {
                timestamp: { $gte: startDate, $lte: endDate },
                status: 'up',
                responseTime: { $exists: true, $gt: 0 }
            }
        }
    ];

    // Add sampling for large datasets
    if (sampleRate < 1) {
        pipeline.push({
            $sample: { size: Math.floor(100000 * sampleRate) }
        });
    }

    pipeline.push(
        {
            $group: {
                _id: groupStage,
                avgTime: { $avg: '$responseTime' },
                count: { $sum: 1 }
            }
        },
        {
            $match: { count: { $gte: 3 } } // Only include periods with sufficient data
        },
        {
            $sort: {
                '_id.year': 1,
                '_id.month': 1,
                '_id.day': 1,
                '_id.hour': 1
            }
        }
    );

    const results = await ServerCheck.aggregate(pipeline).allowDiskUse(true);

    // Format results based on period
    return results.map(item => {
        let name;
        const id = item._id;

        if (period === 'week') {
            name = `${id}:00`;
        } else if (period === 'month') {
            name = `Day ${id.day}, ${id.hour}:00`;
        } else if (period === 'year') {
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            name = `${months[id.month - 1]} ${id.year}`;
        } else {
            name = `${id}:00`;
        }

        return {
            name,
            avgTime: Math.round(item.avgTime || 0),
            dataPoints: item.count
        };
    });
};

/**
 * OPTIMIZED: KPIs with parallel execution and efficient queries
 */
const getKPIsOptimized = async (startDate, endDate, prevStartDate, prevEndDate) => {
    // Execute all KPI queries in parallel for maximum speed
    const [
        [currentUsers, prevUsers],
        [currentServers, prevServers],
        [currentAvgResponse, prevAvgResponse],
        [currentUptime, prevUptime]
    ] = await Promise.all([
        // User counts - efficient single query per period
        Promise.all([
            User.countDocuments({ createdAt: { $lte: endDate } }),
            User.countDocuments({ createdAt: { $lte: prevEndDate } })
        ]),

        // Server counts
        Promise.all([
            Server.countDocuments({ createdAt: { $lte: endDate } }),
            Server.countDocuments({ createdAt: { $lte: prevEndDate } })
        ]),

        // Average response times
        Promise.all([
            getAvgResponseTimeOptimized(startDate, endDate),
            getAvgResponseTimeOptimized(prevStartDate, prevEndDate)
        ]),

        // Uptime percentages
        Promise.all([
            getUptimeOptimized(startDate, endDate),
            getUptimeOptimized(prevStartDate, prevEndDate)
        ])
    ]);

    // Calculate changes efficiently
    const calculateChange = (current, previous) => {
        if (previous === 0) return current === 0 ? 0 : 100;
        return Math.round(((current - previous) / previous) * 100);
    };

    return {
        avgResponseTime: Math.round(currentAvgResponse),
        uptime: Math.round(currentUptime * 10) / 10, // 1 decimal place
        activeServers: currentServers,
        activeUsers: currentUsers,
        responseTimeChange: calculateChange(currentAvgResponse, prevAvgResponse),
        uptimeChange: Math.round((currentUptime - prevUptime) * 10) / 10,
        serversChange: calculateChange(currentServers, prevServers),
        usersChange: calculateChange(currentUsers, prevUsers)
    };
};

/**
 * Ultra-fast average response time calculation
 */
const getAvgResponseTimeOptimized = async (startDate, endDate) => {
    const result = await ServerCheck.aggregate([
        {
            $match: {
                timestamp: { $gte: startDate, $lte: endDate },
                status: 'up',
                responseTime: { $exists: true, $gt: 0 }
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
 * Ultra-fast uptime calculation
 */
const getUptimeOptimized = async (startDate, endDate) => {
    const result = await ServerCheck.aggregate([
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
                    $sum: { $cond: [{ $eq: ['$status', 'up'] }, 1, 0] }
                }
            }
        }
    ]);

    if (result.length === 0) return 100;

    const { totalChecks, upChecks } = result[0];
    return totalChecks > 0 ? (upChecks / totalChecks) * 100 : 100;
};

export default {
    getAnalytics,
    getAnalyticsKPIs,
    getAnalyticsUserGrowth,
    getAnalyticsServerStatus,
    getAnalyticsAlerts,
    getAnalyticsResponseTime
};