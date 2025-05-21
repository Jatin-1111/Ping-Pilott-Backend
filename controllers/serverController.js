import Server from '../models/Server.js';
import ServerCheck from '../models/ServerCheck.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { checkServerStatus } from '../services/monitoringService.js';
import logger from '../utils/logger.js';
import moment from 'moment-timezone';
import mongoose from 'mongoose';

// Server cache with TTL for frequently accessed data
const serverCache = new Map();
const CACHE_TTL = 60 * 1000; // 1 minute in milliseconds
const HISTORY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes for history data

/**
 * @desc    Get all servers for a user
 * @route   GET /api/servers
 * @access  Private
 */
export const getServers = asyncHandler(async (req, res) => {
    const isAdmin = req.user.role === 'admin';
    const showAll = isAdmin && req.query.admin === 'true';
    const userId = req.user.id;

    // Build cache key based on query params
    const cacheKey = `servers:${userId}:${showAll}:${JSON.stringify(req.query)}`;

    // Check cache first
    if (serverCache.has(cacheKey)) {
        const cached = serverCache.get(cacheKey);
        if (cached.timestamp > Date.now() - CACHE_TTL) {
            return res.status(200).json(cached.data);
        }
        serverCache.delete(cacheKey); // Clear expired cache
    }

    // Build filter with optimal query shape
    const filter = showAll ? {} : { uploadedBy: userId };

    // Apply search filter if provided - use $or only when needed
    if (req.query.search) {
        const searchRegex = new RegExp(req.query.search, 'i');
        filter.$or = [
            { name: searchRegex },
            { url: searchRegex },
            { description: searchRegex }
        ];
    }

    // Apply status filter if provided
    if (req.query.status && ['up', 'down', 'unknown'].includes(req.query.status)) {
        filter.status = req.query.status;
    }

    // Apply sorting - use indexes for common sort fields
    const sortBy = req.query.sortBy || 'updatedAt';
    const sortDir = req.query.sortDir === 'asc' ? 1 : -1;
    const sort = { [sortBy]: sortDir };

    // Apply pagination
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    // Execute queries in parallel
    const [total, servers] = await Promise.all([
        Server.countDocuments(filter).lean(),
        Server.find(filter)
            .select('-__v') // Exclude unnecessary fields
            .sort(sort)
            .skip(skip)
            .limit(limit)
            .lean() // Use lean() for better performance
    ]);

    const response = {
        status: 'success',
        results: servers.length,
        total,
        totalPages: Math.ceil(total / limit),
        currentPage: page,
        data: {
            servers
        }
    };

    // Cache the response
    serverCache.set(cacheKey, {
        timestamp: Date.now(),
        data: response
    });

    res.status(200).json(response);
});

/**
 * @desc    Get server by ID
 * @route   GET /api/servers/:id
 * @access  Private
 */
export const getServerById = asyncHandler(async (req, res) => {
    const serverId = req.params.id;
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';

    // Check cache
    const cacheKey = `server:${serverId}:${userId}`;
    if (serverCache.has(cacheKey)) {
        const cached = serverCache.get(cacheKey);
        if (cached.timestamp > Date.now() - CACHE_TTL) {
            return res.status(200).json(cached.data);
        }
        serverCache.delete(cacheKey);
    }

    // Optimize: Use select to get only needed fields
    const server = await Server.findById(serverId).lean();

    if (!server) {
        return res.status(404).json({
            status: 'error',
            message: 'Server not found'
        });
    }

    // Check if user is authorized to access this server
    if (server.uploadedBy !== userId && !isAdmin) {
        return res.status(403).json({
            status: 'error',
            message: 'You are not authorized to access this server'
        });
    }

    // Get timezone-adjusted data for the UI - only compute when needed
    const timezone = server.timezone || 'Asia/Kolkata';
    const lastCheckedLocal = server.lastChecked ?
        moment(server.lastChecked).tz(timezone).format() : null;

    const response = {
        status: 'success',
        data: {
            server: {
                ...server,
                lastCheckedLocal,
                timezone
            }
        }
    };

    // Cache the response
    serverCache.set(cacheKey, {
        timestamp: Date.now(),
        data: response
    });

    res.status(200).json(response);
});

/**
 * @desc    Create a new server
 * @route   POST /api/servers
 * @access  Private
 */
export const createServer = asyncHandler(async (req, res) => {
    const {
        name,
        url,
        type = 'website',
        description = '',
        monitoring = {},
        contactEmails = [],
        contactPhones = []
    } = req.body;

    const userId = req.user.id;
    const userRole = req.user.role;
    const userPlan = req.user.subscription?.plan || 'free';

    // Cache invalidation strategy - only check limits for non-admin users
    if (userRole !== 'admin') {
        const maxServers = req.user.subscription?.features?.maxServers || 1;

        // Only count if user is close to their limit
        if (maxServers < 10) {
            const userServers = await Server.countDocuments({ uploadedBy: userId });
            if (userServers >= maxServers) {
                return res.status(400).json({
                    status: 'error',
                    message: `You've reached your plan's limit of ${maxServers} servers. Please upgrade to add more servers.`
                });
            }
        }
    }

    // Calculate trial end date (2 days from now) for free users
    const trialEnd = userPlan === 'free'
        ? new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).getTime()
        : null;

    // Optimize creation by preparing full object
    const serverData = {
        name,
        url,
        type,
        description,
        uploadedBy: userId,
        uploadedAt: new Date().toISOString(),
        uploadedRole: userRole,
        uploadedPlan: userPlan,
        status: 'unknown',
        monitoring: {
            ...monitoring,
            trialEndsAt: trialEnd
        },
        contactEmails,
        contactPhones
    };

    // Create server
    const server = await Server.create(serverData);

    // Invalidate relevant caches
    // Clear user's server list cache
    const listCachePrefix = `servers:${userId}`;
    for (const [key] of serverCache.entries()) {
        if (key.startsWith(listCachePrefix)) {
            serverCache.delete(key);
        }
    }

    res.status(201).json({
        status: 'success',
        message: 'Server created successfully',
        data: {
            server
        }
    });
});

/**
 * @desc    Update server
 * @route   PATCH /api/servers/:id
 * @access  Private
 */
export const updateServer = asyncHandler(async (req, res) => {
    const serverId = req.params.id;
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';

    // Find server with minimal projection for authorization check
    const server = await Server.findById(serverId);

    if (!server) {
        return res.status(404).json({
            status: 'error',
            message: 'Server not found'
        });
    }

    // Check if user is authorized to update this server
    if (server.uploadedBy !== userId && !isAdmin) {
        return res.status(403).json({
            status: 'error',
            message: 'You are not authorized to update this server'
        });
    }

    // Fields that can be updated - extract only what's provided
    const {
        name,
        url,
        type,
        description,
        monitoring,
        contactEmails,
        contactPhones
    } = req.body;

    // Build update object for optimized update
    const updateFields = {};

    if (name !== undefined) updateFields.name = name;
    if (url !== undefined) updateFields.url = url;
    if (type !== undefined) updateFields.type = type;
    if (description !== undefined) updateFields.description = description;
    if (contactEmails !== undefined) updateFields.contactEmails = contactEmails;
    if (contactPhones !== undefined) updateFields.contactPhones = contactPhones;

    // Handle nested monitoring updates
    if (monitoring) {
        if (monitoring.frequency !== undefined) updateFields['monitoring.frequency'] = monitoring.frequency;
        if (monitoring.daysOfWeek !== undefined) updateFields['monitoring.daysOfWeek'] = monitoring.daysOfWeek;
        if (monitoring.timeWindows !== undefined) updateFields['monitoring.timeWindows'] = monitoring.timeWindows;

        // Handle nested alerts settings
        if (monitoring.alerts) {
            if (monitoring.alerts.enabled !== undefined) updateFields['monitoring.alerts.enabled'] = monitoring.alerts.enabled;
            if (monitoring.alerts.email !== undefined) updateFields['monitoring.alerts.email'] = monitoring.alerts.email;
            if (monitoring.alerts.phone !== undefined) updateFields['monitoring.alerts.phone'] = monitoring.alerts.phone;
            if (monitoring.alerts.responseThreshold !== undefined) updateFields['monitoring.alerts.responseThreshold'] = monitoring.alerts.responseThreshold;
            if (monitoring.alerts.timeWindow !== undefined) updateFields['monitoring.alerts.timeWindow'] = monitoring.alerts.timeWindow;
        }
    }

    // Update with single operation - much faster than save()
    const updatedServer = await Server.findByIdAndUpdate(
        serverId,
        { $set: updateFields },
        { new: true, runValidators: true }
    );

    // Invalidate caches
    // Clear all caches related to this server
    for (const [key] of serverCache.entries()) {
        if (key.includes(serverId) || key.startsWith(`servers:${userId}`)) {
            serverCache.delete(key);
        }
    }

    res.status(200).json({
        status: 'success',
        message: 'Server updated successfully',
        data: {
            server: updatedServer
        }
    });
});

/**
 * @desc    Delete server
 * @route   DELETE /api/servers/:id
 * @access  Private
 */
export const deleteServer = asyncHandler(async (req, res) => {
    const serverId = req.params.id;
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';

    // Find server with minimal projection for auth check
    const server = await Server.findById(serverId, { uploadedBy: 1 });

    if (!server) {
        return res.status(404).json({
            status: 'error',
            message: 'Server not found'
        });
    }

    // Check if user is authorized to delete this server
    if (server.uploadedBy !== userId && !isAdmin) {
        return res.status(403).json({
            status: 'error',
            message: 'You are not authorized to delete this server'
        });
    }

    // Optimize: Use deleteOne directly instead of finding first
    await Server.deleteOne({ _id: serverId });

    // Also clean up associated checks in the background - don't wait for completion
    ServerCheck.deleteMany({ serverId }).exec()
        .catch(err => logger.error(`Error cleaning up server checks: ${err.message}`));

    // Invalidate caches
    for (const [key] of serverCache.entries()) {
        if (key.includes(serverId) || key.startsWith(`servers:${userId}`)) {
            serverCache.delete(key);
        }
    }

    res.status(200).json({
        status: 'success',
        message: 'Server deleted successfully'
    });
});

/**
 * @desc    Manually check server status
 * @route   POST /api/servers/:id/check
 * @access  Private
 */
export const checkServer = asyncHandler(async (req, res) => {
    const serverId = req.params.id;
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';

    // Find server - use projection to get only required fields
    const server = await Server.findById(serverId);

    if (!server) {
        return res.status(404).json({
            status: 'error',
            message: 'Server not found'
        });
    }

    // Check if user is authorized to check this server
    if (server.uploadedBy !== userId && !isAdmin) {
        return res.status(403).json({
            status: 'error',
            message: 'You are not authorized to check this server'
        });
    }

    try {
        // Prepare data needed for server check
        const oldStatus = server.status;
        const now = new Date();

        // Call the monitoring service
        const checkResult = await checkServerStatus(server);

        // Prepare update data
        const updateData = {
            status: checkResult.status,
            responseTime: checkResult.responseTime,
            error: checkResult.error,
            lastChecked: now
        };

        // Add status change time if status changed
        if (oldStatus !== checkResult.status) {
            updateData.lastStatusChange = now;
        }

        // Batch operations - run in parallel
        await Promise.all([
            // Update server in a single operation
            Server.findByIdAndUpdate(serverId, updateData),

            // Create check record in parallel
            ServerCheck.create({
                serverId: server._id,
                status: checkResult.status,
                responseTime: checkResult.responseTime,
                error: checkResult.error,
                timestamp: now,
                timezone: server.timezone || 'Asia/Kolkata',
                localDate: now.toISOString().split('T')[0], // YYYY-MM-DD
                localHour: now.getHours(),
                localMinute: now.getMinutes(),
                timeSlot: Math.floor(now.getMinutes() / 15) // 15-minute slots (0-3)
            })
        ]);

        // Invalidate caches
        for (const [key] of serverCache.entries()) {
            if (key.includes(serverId)) {
                serverCache.delete(key);
            }
        }

        res.status(200).json({
            status: 'success',
            message: 'Server checked successfully',
            data: {
                status: checkResult.status,
                responseTime: checkResult.responseTime,
                error: checkResult.error,
                lastChecked: now
            }
        });
    } catch (error) {
        logger.error(`Error checking server ${serverId}: ${error.message}`);

        res.status(500).json({
            status: 'error',
            message: 'Failed to check server',
            error: error.message
        });
    }
});

/**
 * @desc    Get server check history
 * @route   GET /api/servers/:id/history
 * @access  Private
 */
export const getServerHistory = asyncHandler(async (req, res) => {
    const serverId = req.params.id;
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';
    const period = req.query.period || '24h';

    // Check cache first
    const cacheKey = `serverHistory:${serverId}:${period}:${userId}`;
    if (serverCache.has(cacheKey)) {
        const cached = serverCache.get(cacheKey);
        if (cached.timestamp > Date.now() - HISTORY_CACHE_TTL) {
            return res.status(200).json(cached.data);
        }
        serverCache.delete(cacheKey);
    }

    // First, check authorization with minimal projection
    const server = await Server.findById(serverId, { uploadedBy: 1 });

    if (!server) {
        return res.status(404).json({
            status: 'error',
            message: 'Server not found'
        });
    }

    // Check if user is authorized to view this server's history
    if (server.uploadedBy !== userId && !isAdmin) {
        return res.status(403).json({
            status: 'error',
            message: 'You are not authorized to view this server history'
        });
    }

    // Calculate start time based on period
    const now = new Date();
    let startTime;

    // Only allow periods up to 24h since we only keep current day's data
    switch (period) {
        case '1h':
            startTime = new Date(now.getTime() - 1 * 60 * 60 * 1000);
            break;
        case '6h':
            startTime = new Date(now.getTime() - 6 * 60 * 60 * 1000);
            break;
        case '12h':
            startTime = new Date(now.getTime() - 12 * 60 * 60 * 1000);
            break;
        case '24h':
        default:
            // Get start of today
            startTime = new Date();
            startTime.setHours(0, 0, 0, 0);
    }

    // Get aggregate statistics directly from database instead of loading all records
    const [checks, stats] = await Promise.all([
        // Get check history with specific fields only
        ServerCheck.find({
            serverId,
            timestamp: { $gte: startTime }
        })
            .select('status responseTime timestamp error')
            .sort({ timestamp: 1 })
            .lean(),

        // Calculate statistics using aggregation - much more efficient
        ServerCheck.aggregate([
            {
                $match: {
                    serverId: new mongoose.Types.ObjectId(serverId),
                    timestamp: { $gte: startTime }
                }
            },
            {
                $group: {
                    _id: null,
                    totalChecks: { $sum: 1 },
                    upChecks: {
                        $sum: { $cond: [{ $eq: ['$status', 'up'] }, 1, 0] }
                    },
                    downChecks: {
                        $sum: { $cond: [{ $eq: ['$status', 'down'] }, 1, 0] }
                    },
                    responseTimes: {
                        $push: {
                            $cond: [
                                { $eq: ['$status', 'up'] },
                                '$responseTime',
                                null
                            ]
                        }
                    }
                }
            }
        ])
    ]);

    // Calculate stats from aggregation results
    let uptimePercent = 0;
    let avgResponseTime = 0;
    let totalChecks = 0;
    let downChecks = 0;

    if (stats.length > 0) {
        const { totalChecks: total, upChecks, downChecks: down, responseTimes } = stats[0];

        // Filter out null values and calculate average
        const validResponseTimes = responseTimes.filter(time => time !== null);

        totalChecks = total;
        downChecks = down;
        uptimePercent = total > 0 ? (upChecks / total) * 100 : 0;
        avgResponseTime = validResponseTimes.length > 0
            ? validResponseTimes.reduce((sum, time) => sum + time, 0) / validResponseTimes.length
            : 0;
    }

    const response = {
        status: 'success',
        data: {
            period,
            history: checks,
            stats: {
                uptimePercent: parseFloat(uptimePercent.toFixed(2)),
                avgResponseTime: Math.round(avgResponseTime),
                totalChecks,
                downChecks
            }
        }
    };

    // Cache the response
    serverCache.set(cacheKey, {
        timestamp: Date.now(),
        data: response
    });

    res.status(200).json(response);
});

// Cache management - clean up expired items periodically
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of serverCache.entries()) {
        const ttl = key.includes('History') ? HISTORY_CACHE_TTL : CACHE_TTL;
        if (value.timestamp < now - ttl) {
            serverCache.delete(key);
        }
    }
}, 60000); // Run every minute

export default {
    getServers,
    getServerById,
    createServer,
    updateServer,
    deleteServer,
    checkServer,
    getServerHistory
};