// controllers/analyticsController.js - admin analytics
//
// What changed from the first version:
//  - The date range comes from `period` on the server. Clients used to send their own dates, which also
//    meant no two requests ever shared a cache entry.
//  - Results are cached for 5 minutes. The admin overview polls every minute and each call ran a dozen
//    aggregations over every check ever stored.
//  - "Alerts" counts alerts that were actually delivered (AlertEvent), not servers that are down right now.
//  - "Active servers" / "active users" mean what they say: servers still being monitored, and users who
//    own at least one server. They used to be all-time counts of everything ever created.
//  - Uptime is null when there is no data, instead of a reassuring 100%.

import User from '../models/User.js';
import Server from '../models/Server.js';
import ServerCheck from '../models/ServerCheck.js';
import AlertEvent from '../models/AlertEvent.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getCachedData, setCachedData } from '../utils/cacheManager.js';
import { CACHE_STRATEGIES } from '../config/performance.js';
import logger from '../utils/logger.js';

const DAY = 24 * 60 * 60 * 1000;
const PERIOD_DAYS = { week: 7, month: 30, year: 365 };
const QUERY_TIMEOUT = 20000;

/** Current and previous period for `period` (week | month | year). Unknown values mean month. */
const resolveRange = (query) => {
    const period = PERIOD_DAYS[query.period] ? query.period : 'month';
    const span = PERIOD_DAYS[period] * DAY;
    const end = new Date();
    const start = new Date(end.getTime() - span);
    return {
        period,
        start,
        end,
        prevStart: new Date(start.getTime() - span),
        prevEnd: new Date(start.getTime() - 1)
    };
};

/** Servers that are still being checked: not past a free trial. */
const monitoredFilter = (extra = {}) => ({
    ...extra,
    $nor: [{ uploadedPlan: 'free', 'monitoring.trialEndsAt': { $lt: new Date() } }]
});

/**
 * @desc    Get admin dashboard analytics data
 * @route   GET /api/admin/analytics
 * @access  Private/Admin
 */
export const getAnalytics = asyncHandler(async (req, res) => {
    const startTime = Date.now();
    const range = resolveRange(req.query);
    const cacheKey = `api:analytics:admin:${range.period}`;

    const cached = await getCachedData(cacheKey);
    if (cached) {
        return res.status(200).json({ ...cached, meta: { ...cached.meta, cached: true } });
    }

    try {
        const [userStats, serverStats, alertStats, responseTimeStats, kpiStats] = await Promise.all([
            getUserGrowthOptimized(range.start, range.end, range.period),
            getServerStatusOptimized(),
            getAlertsByTypeOptimized(range.start, range.end),
            getResponseTimeOptimized(range.start, range.end, range.period),
            getKPIsOptimized(range.start, range.end, range.prevStart, range.prevEnd)
        ]);

        const body = {
            status: 'success',
            message: 'Analytics data retrieved successfully',
            data: {
                userGrowth: userStats,
                serverStatus: serverStats,
                alertsByType: alertStats,
                responseTime: responseTimeStats,
                kpis: kpiStats,
                meta: {
                    queryTime: Date.now() - startTime,
                    period: range.period,
                    dateRange: { start: range.start, end: range.end }
                }
            },
            meta: { cached: false }
        };

        await setCachedData(cacheKey, body, CACHE_STRATEGIES.analytics);
        res.status(200).json(body);
    } catch (error) {
        // The reason stays in the log; callers get a generic message
        logger.error(`❌ Analytics error: ${error.message}`);
        res.status(500).json({
            status: 'error',
            message: 'Failed to retrieve analytics data'
        });
    }
});

export const getAnalyticsKPIs = asyncHandler(async (req, res) => {
    const r = resolveRange(req.query);
    res.status(200).json({ status: 'success', data: await getKPIsOptimized(r.start, r.end, r.prevStart, r.prevEnd) });
});

export const getAnalyticsUserGrowth = asyncHandler(async (req, res) => {
    const r = resolveRange(req.query);
    res.status(200).json({ status: 'success', data: await getUserGrowthOptimized(r.start, r.end, r.period) });
});

export const getAnalyticsServerStatus = asyncHandler(async (req, res) => {
    res.status(200).json({ status: 'success', data: await getServerStatusOptimized() });
});

export const getAnalyticsAlerts = asyncHandler(async (req, res) => {
    const r = resolveRange(req.query);
    res.status(200).json({ status: 'success', data: await getAlertsByTypeOptimized(r.start, r.end) });
});

export const getAnalyticsResponseTime = asyncHandler(async (req, res) => {
    const r = resolveRange(req.query);
    res.status(200).json({ status: 'success', data: await getResponseTimeOptimized(r.start, r.end, r.period) });
});

/** New accounts per day (per month for a year) */
const getUserGrowthOptimized = async (startDate, endDate, period) => {
    const format = period === 'year' ? '%Y-%m' : '%Y-%m-%d';

    return User.aggregate([
        { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: { $dateToString: { format, date: '$createdAt' } }, users: { $sum: 1 } } },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, name: '$_id', users: 1 } }
    ]).option({ maxTimeMS: QUERY_TIMEOUT });
};

/** Up / down / pending right now */
const getServerStatusOptimized = async () => {
    const results = await Server.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
    ]).option({ maxTimeMS: QUERY_TIMEOUT });

    const statusMap = { UP: 0, DOWN: 0, UNKNOWN: 0 };
    results.forEach((item) => {
        statusMap[String(item._id).toUpperCase()] = item.count;
    });

    return Object.entries(statusMap).map(([name, value]) => ({ name, value }));
};

/** Alerts that were delivered in the period, by kind */
const getAlertsByTypeOptimized = async (startDate, endDate) => {
    const results = await AlertEvent.aggregate([
        { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: '$type', value: { $sum: 1 } } }
    ]).option({ maxTimeMS: QUERY_TIMEOUT });

    const labels = { server_down: 'Server down', server_recovery: 'Recovered', slow_response: 'Slow response' };
    const counts = Object.fromEntries(Object.values(labels).map((label) => [label, 0]));
    results.forEach((item) => {
        if (labels[item._id]) counts[labels[item._id]] = item.value;
    });

    return Object.entries(counts).map(([name, value]) => ({ name, value }));
};

/** Average response time of successful checks, bucketed by hour (week, month) or month (year) */
const getResponseTimeOptimized = async (startDate, endDate, period) => {
    const groupStage = period === 'year'
        ? { year: { $year: '$timestamp' }, month: { $month: '$timestamp' } }
        : {
            year: { $year: '$timestamp' },
            month: { $month: '$timestamp' },
            day: { $dayOfMonth: '$timestamp' },
            // A week is read hour by hour, a month day by day: 720 hourly points would not fit a chart
            ...(period === 'week' ? { hour: { $hour: '$timestamp' } } : {})
        };

    const results = await ServerCheck.aggregate([
        {
            $match: {
                timestamp: { $gte: startDate, $lte: endDate },
                status: 'up',
                responseTime: { $gt: 0 }
            }
        },
        { $group: { _id: groupStage, avgTime: { $avg: '$responseTime' }, count: { $sum: 1 } } },
        { $match: { count: { $gte: 3 } } }, // only periods with enough data to mean something
        { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.hour': 1 } }
    ]).option({ maxTimeMS: QUERY_TIMEOUT, allowDiskUse: true });

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    return results.map(({ _id: id, avgTime, count }) => {
        let name;
        if (period === 'year') name = `${months[id.month - 1]} ${id.year}`;
        else if (period === 'week') name = `${months[id.month - 1]} ${id.day}, ${String(id.hour).padStart(2, '0')}:00`;
        else name = `${months[id.month - 1]} ${id.day}`;

        return { name, avgTime: Math.round(avgTime || 0), dataPoints: count };
    });
};

const getAvgResponseTimeOptimized = async (startDate, endDate) => {
    const result = await ServerCheck.aggregate([
        { $match: { timestamp: { $gte: startDate, $lte: endDate }, status: 'up', responseTime: { $gt: 0 } } },
        { $group: { _id: null, avgResponseTime: { $avg: '$responseTime' } } }
    ]).option({ maxTimeMS: QUERY_TIMEOUT });

    return result.length > 0 ? result[0].avgResponseTime : 0;
};

/** Share of checks that succeeded, or null when there were none (no data is not 100%) */
const getUptimeOptimized = async (startDate, endDate) => {
    const result = await ServerCheck.aggregate([
        { $match: { timestamp: { $gte: startDate, $lte: endDate } } },
        {
            $group: {
                _id: null,
                totalChecks: { $sum: 1 },
                upChecks: { $sum: { $cond: [{ $eq: ['$status', 'up'] }, 1, 0] } }
            }
        }
    ]).option({ maxTimeMS: QUERY_TIMEOUT });

    if (result.length === 0 || result[0].totalChecks === 0) return null;
    return (result[0].upChecks / result[0].totalChecks) * 100;
};

const getKPIsOptimized = async (startDate, endDate, prevStartDate, prevEndDate) => {
    const [
        [currentOwners, prevOwners],
        [currentServers, prevServers],
        [currentAvgResponse, prevAvgResponse],
        [currentUptime, prevUptime]
    ] = await Promise.all([
        // Users who own at least one server, now and at the end of the previous period
        Promise.all([
            Server.distinct('uploadedBy', monitoredFilter({ createdAt: { $lte: endDate } })),
            Server.distinct('uploadedBy', monitoredFilter({ createdAt: { $lte: prevEndDate } }))
        ]).then(([a, b]) => [a.length, b.length]),

        // Servers still being monitored
        Promise.all([
            Server.countDocuments(monitoredFilter({ createdAt: { $lte: endDate } })),
            Server.countDocuments(monitoredFilter({ createdAt: { $lte: prevEndDate } }))
        ]),

        Promise.all([
            getAvgResponseTimeOptimized(startDate, endDate),
            getAvgResponseTimeOptimized(prevStartDate, prevEndDate)
        ]),

        Promise.all([
            getUptimeOptimized(startDate, endDate),
            getUptimeOptimized(prevStartDate, prevEndDate)
        ])
    ]);

    const calculateChange = (current, previous) => {
        if (!previous) return current === 0 ? 0 : 100;
        return Math.round(((current - previous) / previous) * 100);
    };

    return {
        avgResponseTime: Math.round(currentAvgResponse),
        uptime: currentUptime === null ? null : Math.round(currentUptime * 10) / 10,
        activeServers: currentServers,
        activeUsers: currentOwners,
        responseTimeChange: calculateChange(currentAvgResponse, prevAvgResponse),
        uptimeChange: currentUptime === null || prevUptime === null ? 0 : Math.round((currentUptime - prevUptime) * 10) / 10,
        serversChange: calculateChange(currentServers, prevServers),
        usersChange: calculateChange(currentOwners, prevOwners)
    };
};

export default {
    getAnalytics,
    getAnalyticsKPIs,
    getAnalyticsUserGrowth,
    getAnalyticsServerStatus,
    getAnalyticsAlerts,
    getAnalyticsResponseTime
};
