import Server from '../models/Server.js';
import ServerCheck from '../models/ServerCheck.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { checkServerStatus } from '../services/monitoringService.js';
import logger from '../utils/logger.js';

/**
 * @desc    Get all servers for a user
 * @route   GET /api/servers
 * @access  Private
 */
export const getServers = asyncHandler(async (req, res) => {
    // If admin user and admin=true query param, return all servers
    const isAdmin = req.user.role === 'admin';
    const showAll = isAdmin && req.query.admin === 'true';

    const filter = showAll ? {} : { uploadedBy: req.user.id };

    // Apply search filter if provided
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

    // Apply sorting
    const sortBy = req.query.sortBy || 'updatedAt';
    const sortDir = req.query.sortDir === 'asc' ? 1 : -1;
    const sort = { [sortBy]: sortDir };

    // Apply pagination
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    // Get total count for pagination
    const total = await Server.countDocuments(filter);

    // Get servers
    const servers = await Server.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit);

    res.status(200).json({
        status: 'success',
        results: servers.length,
        total,
        totalPages: Math.ceil(total / limit),
        currentPage: page,
        data: {
            servers
        }
    });
});

/**
 * @desc    Get server by ID
 * @route   GET /api/servers/:id
 * @access  Private
 */
export const getServerById = asyncHandler(async (req, res) => {
    const server = await Server.findById(req.params.id);

    if (!server) {
        return res.status(404).json({
            status: 'error',
            message: 'Server not found'
        });
    }

    // Check if user is authorized to access this server
    if (server.uploadedBy !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({
            status: 'error',
            message: 'You are not authorized to access this server'
        });
    }

    res.status(200).json({
        status: 'success',
        data: {
            server
        }
    });
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

    // Check if user has reached their server limit
    const userServers = await Server.countDocuments({ uploadedBy: req.user.id });
    const maxServers = req.user.subscription?.features?.maxServers || 1;

    if (userServers >= maxServers && req.user.role !== 'admin') {
        return res.status(400).json({
            status: 'error',
            message: `You've reached your plan's limit of ${maxServers} servers. Please upgrade to add more servers.`
        });
    }

    // Calculate trial end date (2 days from now) for free users
    const trialEnd = req.user.subscription?.plan === 'free'
        ? new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).getTime()
        : null;

    // Create server
    const server = await Server.create({
        name,
        url,
        type,
        description,
        uploadedBy: req.user.id,
        uploadedAt: new Date().toISOString(),
        uploadedRole: req.user.role,
        uploadedPlan: req.user.subscription?.plan || 'free',
        status: 'unknown',
        monitoring: {
            ...monitoring,
            trialEndsAt: trialEnd
        },
        contactEmails,
        contactPhones
    });

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
    // Find server
    const server = await Server.findById(req.params.id);

    if (!server) {
        return res.status(404).json({
            status: 'error',
            message: 'Server not found'
        });
    }

    // Check if user is authorized to update this server
    if (server.uploadedBy !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({
            status: 'error',
            message: 'You are not authorized to update this server'
        });
    }

    // Fields that can be updated
    const {
        name,
        url,
        type,
        description,
        monitoring,
        contactEmails,
        contactPhones
    } = req.body;

    // Update fields if provided
    if (name) server.name = name;
    if (url) server.url = url;
    if (type) server.type = type;
    if (description !== undefined) server.description = description;

    // Update monitoring settings if provided
    if (monitoring) {
        // Handle nested properties carefully
        if (monitoring.frequency !== undefined) {
            server.monitoring.frequency = monitoring.frequency;
        }

        if (monitoring.daysOfWeek !== undefined) {
            server.monitoring.daysOfWeek = monitoring.daysOfWeek;
        }

        if (monitoring.timeWindows !== undefined) {
            server.monitoring.timeWindows = monitoring.timeWindows;
        }

        // Handle alerts settings
        if (monitoring.alerts !== undefined) {
            if (monitoring.alerts.enabled !== undefined) {
                server.monitoring.alerts.enabled = monitoring.alerts.enabled;
            }

            if (monitoring.alerts.email !== undefined) {
                server.monitoring.alerts.email = monitoring.alerts.email;
            }

            if (monitoring.alerts.phone !== undefined) {
                server.monitoring.alerts.phone = monitoring.alerts.phone;
            }

            if (monitoring.alerts.responseThreshold !== undefined) {
                server.monitoring.alerts.responseThreshold = monitoring.alerts.responseThreshold;
            }

            if (monitoring.alerts.timeWindow !== undefined) {
                server.monitoring.alerts.timeWindow = monitoring.alerts.timeWindow;
            }
        }
    }

    // Update contact information if provided
    if (contactEmails !== undefined) {
        server.contactEmails = contactEmails;
    }

    if (contactPhones !== undefined) {
        server.contactPhones = contactPhones;
    }

    // Save updates
    await server.save();

    res.status(200).json({
        status: 'success',
        message: 'Server updated successfully',
        data: {
            server
        }
    });
});

/**
 * @desc    Delete server
 * @route   DELETE /api/servers/:id
 * @access  Private
 */
export const deleteServer = asyncHandler(async (req, res) => {
    // Find server
    const server = await Server.findById(req.params.id);

    if (!server) {
        return res.status(404).json({
            status: 'error',
            message: 'Server not found'
        });
    }

    // Check if user is authorized to delete this server
    if (server.uploadedBy !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({
            status: 'error',
            message: 'You are not authorized to delete this server'
        });
    }

    // Delete server
    await server.deleteOne();

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
    // Find server
    const server = await Server.findById(req.params.id);

    if (!server) {
        return res.status(404).json({
            status: 'error',
            message: 'Server not found'
        });
    }

    // Check if user is authorized to check this server
    if (server.uploadedBy !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({
            status: 'error',
            message: 'You are not authorized to check this server'
        });
    }

    try {
        // Check server status
        const oldStatus = server.status;

        // Call the monitoring service
        const checkResult = await checkServerStatus(server);

        // Update server with check results
        server.status = checkResult.status;
        server.responseTime = checkResult.responseTime;
        server.error = checkResult.error;
        server.lastChecked = new Date();

        // If status changed, record the change time
        if (oldStatus !== checkResult.status) {
            server.lastStatusChange = new Date();
        }

        // Save server updates
        await server.save();

        // Record check history
        const now = new Date();
        const check = new ServerCheck({
            serverId: server._id,
            status: checkResult.status,
            responseTime: checkResult.responseTime,
            error: checkResult.error,
            timestamp: now,
            date: now.toISOString().split('T')[0], // YYYY-MM-DD
            hour: now.getHours(),
            minute: now.getMinutes(),
            timeSlot: Math.floor(now.getMinutes() / 15), // 15-minute slots (0-3)
        });

        await check.save();

        res.status(200).json({
            status: 'success',
            message: 'Server checked successfully',
            data: {
                status: checkResult.status,
                responseTime: checkResult.responseTime,
                error: checkResult.error,
                lastChecked: server.lastChecked
            }
        });
    } catch (error) {
        logger.error(`Error checking server ${server.id}: ${error.message}`);

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

    // Find server
    const server = await Server.findById(serverId);

    if (!server) {
        return res.status(404).json({
            status: 'error',
            message: 'Server not found'
        });
    }

    // Check if user is authorized to view this server's history
    if (server.uploadedBy !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({
            status: 'error',
            message: 'You are not authorized to view this server history'
        });
    }

    // Get time range from query params
    const { period = '24h' } = req.query;

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

    // Get detailed check history
    const checks = await ServerCheck.find({
        serverId,
        timestamp: { $gte: startTime }
    }).sort({ timestamp: 1 });

    // Calculate stats
    const uptimePercent = checks.length > 0
        ? (checks.filter(check => check.status === 'up').length / checks.length) * 100
        : 0;

    const upChecks = checks.filter(check => check.status === 'up');
    const avgResponseTime = upChecks.length > 0
        ? upChecks.reduce((sum, check) => sum + (check.responseTime || 0), 0) / upChecks.length
        : 0;

    res.status(200).json({
        status: 'success',
        data: {
            period,
            history: checks,
            stats: {
                uptimePercent: parseFloat(uptimePercent.toFixed(2)),
                avgResponseTime: Math.round(avgResponseTime),
                totalChecks: checks.length,
                downChecks: checks.filter(check => check.status === 'down').length
            }
        }
    });
});

export default {
    getServers,
    getServerById,
    createServer,
    updateServer,
    deleteServer,
    checkServer,
    getServerHistory
};