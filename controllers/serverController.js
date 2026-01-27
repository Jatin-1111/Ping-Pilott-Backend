// controllers/serverController.js - COMPLETE OPTIMIZED VERSION ⚡

import Server from '../models/Server.js';
import ServerCheck from '../models/ServerCheck.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { checkServerStatus } from '../services/monitoringService.js';
import { redisConnection } from '../config/redis.js';
import logger from '../utils/logger.js';
import mongoose from 'mongoose';
import { createServerSchema, updateServerSchema } from '../utils/validations.js';

// Performance monitoring
const PERFORMANCE_CONFIG = {
    MAX_SERVERS_PER_REQUEST: 50,
    MAX_HISTORY_POINTS: 1440, // 24 hours at 1-minute intervals
    BATCH_CHECK_LIMIT: 10,
    QUERY_TIMEOUT: 10000 // 10 seconds
};

/**
 * @desc    Get all servers for a user - FULLY OPTIMIZED
 * @route   GET /api/servers
 * @access  Private
 */
export const getServers = asyncHandler(async (req, res) => {
    const startTime = Date.now();
    const isAdmin = req.user.role === 'admin';
    const showAll = isAdmin && req.query.admin === 'true';
    const userId = req.user.id;

    // Redis Cache Key Generation
    const cacheKey = `api:servers:${userId}:${JSON.stringify(req.query)}`;

    try {
        // 1. Try Cache
        const cachedData = await redisConnection.get(cacheKey);
        if (cachedData) {
            const data = JSON.parse(cachedData);
            // Add cache meta header
            data.meta.cached = true;
            data.meta.queryTime = 0; // Instant
            return res.status(200).json(data);
        }

        // Build optimized filter with early returns
        const filter = showAll ? {} : { uploadedBy: userId };

        // Search optimization - only add complex $or when actually needed
        if (req.query.search?.trim()) {
            const searchTerm = req.query.search.trim();
            const searchRegex = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            filter.$or = [
                { name: searchRegex },
                { url: searchRegex },
                { description: searchRegex }
            ];
        }

        // Status filter with validation
        if (req.query.status && ['up', 'down', 'unknown'].includes(req.query.status)) {
            filter.status = req.query.status;
        }

        // Type filter
        if (req.query.type && ['website', 'api', 'tcp', 'database'].includes(req.query.type)) {
            filter.type = req.query.type;
        }

        // Plan filter (admin only)
        if (isAdmin && req.query.plan && ['free', 'starter_monthly', 'starter_yearly', 'pro_monthly', 'pro_yearly', 'business_monthly', 'business_yearly', 'admin'].includes(req.query.plan)) {
            filter.uploadedPlan = req.query.plan;
        }

        // Pagination with sensible limits
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(PERFORMANCE_CONFIG.MAX_SERVERS_PER_REQUEST, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const skip = (page - 1) * limit;

        // Sorting optimization - use indexes
        const allowedSortFields = ['name', 'status', 'lastChecked', 'createdAt', 'updatedAt', 'responseTime'];
        const sortBy = allowedSortFields.includes(req.query.sortBy) ? req.query.sortBy : 'updatedAt';
        const sortDir = req.query.sortDir === 'asc' ? 1 : -1;
        const sort = { [sortBy]: sortDir };

        // Execute queries in parallel for maximum performance
        const [servers, total] = await Promise.all([
            (() => {
                let query = Server.find(filter)
                    .select('-__v -verificationToken -resetToken') // Exclude unnecessary fields
                    .sort(sort)
                    .skip(skip)
                    .limit(limit);

                // Populate user details for admin view
                if (showAll) {
                    query = query.populate('uploadedBy', 'displayName email');
                }

                return query.lean() // Use lean for 40% better performance
                    .maxTimeMS(PERFORMANCE_CONFIG.QUERY_TIMEOUT);
            })(),

            Server.countDocuments(filter)
                .maxTimeMS(PERFORMANCE_CONFIG.QUERY_TIMEOUT)
        ]);

        // Enhance servers with computed fields efficiently
        const enhancedServers = servers.map(server => {
            const lastCheckedLocal = server.lastChecked ? new Date(server.lastChecked).toISOString() : null;

            // Health status calculation
            const isHealthy = server.status === 'up' &&
                (!server.responseTime || server.responseTime < 2000);

            // Trial status for free users
            const trialExpired = server.uploadedPlan === 'free' &&
                server.monitoring?.trialEndsAt &&
                server.monitoring.trialEndsAt < Date.now();

            return {
                ...server,
                lastCheckedLocal,
                isHealthy,
                trialExpired,
                // Add next check estimation
                nextCheckEstimate: getNextCheckEstimate(server)
            };
        });

        const queryTime = Date.now() - startTime;

        const responseData = {
            status: 'success',
            results: servers.length,
            total,
            totalPages: Math.ceil(total / limit),
            currentPage: page,
            data: {
                servers: enhancedServers
            },
            meta: {
                queryTime,
                cached: false,
                filters: Object.keys(filter)
            }
        };

        // 2. Set Cache (10 seconds TTL)
        // 10s is enough to save DB from polling spam, but keeps UI seemingly fresh on refresh
        await redisConnection.set(cacheKey, JSON.stringify(responseData), 'EX', 10);

        res.status(200).json(responseData);

        // Log slow queries for optimization
        if (queryTime > 1000) {
            logger.warn(`Slow servers query: ${queryTime}ms`, { filter, userId });
        }

    } catch (error) {
        logger.error(`Error fetching servers for user ${userId}: ${error.message}`, {
            stack: error.stack,
            filter: req.query
        });

        res.status(500).json({
            status: 'error',
            message: 'Failed to fetch servers',
            code: 'FETCH_SERVERS_ERROR'
        });
    }
});

/**
 * @desc    Get server by ID with enhanced data - OPTIMIZED
 * @route   GET /api/servers/:id  
 * @access  Private
 */
export const getServerById = asyncHandler(async (req, res) => {
    const serverId = req.params.id;
    const userId = req.user._id.toString(); // Use _id instead of id
    const isAdmin = req.user.role === 'admin';
    const includeRecent = req.query.includeRecent === 'true';

    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(serverId)) {
        return res.status(400).json({
            status: 'error',
            message: 'Invalid server ID format',
            code: 'INVALID_SERVER_ID'
        });
    }

    try {
        const startTime = Date.now();

        // Query server with potential recent checks in parallel
        const [server, recentChecks] = await Promise.all([
            Server.findById(serverId)
                .select('-__v')
                .lean()
                .maxTimeMS(PERFORMANCE_CONFIG.QUERY_TIMEOUT),

            includeRecent ?
                ServerCheck.find({ serverId: new mongoose.Types.ObjectId(serverId) })
                    .sort({ timestamp: -1 })
                    .limit(10)
                    .select('status responseTime timestamp error')
                    .lean()
                    .maxTimeMS(PERFORMANCE_CONFIG.QUERY_TIMEOUT)
                : Promise.resolve([])
        ]);

        if (!server) {
            return res.status(404).json({
                status: 'error',
                message: 'Server not found',
                code: 'SERVER_NOT_FOUND'
            });
        }

        // Authorization check - ensure both are strings for comparison
        if (String(server.uploadedBy) !== String(userId) && !isAdmin) {
            return res.status(403).json({
                status: 'error',
                message: 'Not authorized to access this server',
                code: 'UNAUTHORIZED_ACCESS'
            });
        }

        // Enhance server data
        const enhancedServer = {
            ...server,
            lastCheckedLocal: server.lastChecked ? new Date(server.lastChecked).toISOString() : null,
            lastStatusChangeLocal: server.lastStatusChange ? new Date(server.lastStatusChange).toISOString() : null,
            isHealthy: server.status === 'up' && (!server.responseTime || server.responseTime < 2000),
            nextCheckEstimate: getNextCheckEstimate(server),
            trialExpired: server.uploadedPlan === 'free' &&
                server.monitoring?.trialEndsAt &&
                server.monitoring.trialEndsAt < Date.now(),
            canBeChecked: canBeCheckedNow(server),
            ...(includeRecent && { recentChecks })
        };

        const queryTime = Date.now() - startTime;

        res.status(200).json({
            status: 'success',
            data: {
                server: enhancedServer
            },
            meta: {
                queryTime,
                includeRecent
            }
        });

    } catch (error) {
        logger.error(`Error fetching server ${serverId}: ${error.message}`, {
            userId,
            stack: error.stack
        });

        res.status(500).json({
            status: 'error',
            message: 'Failed to fetch server',
            code: 'FETCH_SERVER_ERROR'
        });
    }
});

/**
 * @desc    Create a new server - FULLY OPTIMIZED
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
        contactPhones = [],
        priority = 'medium'
    } = req.body;

    const userId = req.user.id;
    const userRole = req.user.role;
    const userPlan = req.user.subscription?.plan || 'free';
    // Premium checks (Pro, Business, Admin)
    const isPremium = ['pro_monthly', 'pro_yearly', 'business_monthly', 'business_yearly', 'admin'].includes(userPlan);

    try {
        // Zod Validation
        const validationResult = createServerSchema.safeParse(req.body);

        if (!validationResult.success) {
            return res.status(400).json({
                status: 'error',
                message: 'Validation error',
                code: 'VALIDATION_ERROR',
                errors: validationResult.error.errors.map(err => ({
                    field: err.path.join('.'),
                    message: err.message
                }))
            });
        }

        const {
            name,
            url,
            type,
            description,
            monitoring,
            contactEmails,
            contactPhones,
            priority
        } = validationResult.data;

        // URL validation and normalization
        const normalizedUrl = normalizeUrl(url.trim());
        if (!normalizedUrl) {
            return res.status(400).json({
                status: 'error',
                message: 'Invalid URL format',
                code: 'INVALID_URL'
            });
        }

        // Check for duplicate URL for this user
        const existingServer = await Server.findOne({
            uploadedBy: userId,
            url: normalizedUrl
        }, { _id: 1 }).lean();

        if (existingServer) {
            return res.status(400).json({
                status: 'error',
                message: 'A server with this URL already exists in your account',
                code: 'DUPLICATE_URL'
            });
        }

        // Check server limits for non-admin users
        if (userRole !== 'admin') {
            const maxServers = req.user.subscription?.features?.maxServers || 1;

            if (maxServers > 0) { // -1 means unlimited
                const userServerCount = await Server.countDocuments({ uploadedBy: userId });

                if (userServerCount >= maxServers) {
                    return res.status(400).json({
                        status: 'error',
                        message: `Server limit reached. Your ${userPlan} plan allows ${maxServers} server${maxServers > 1 ? 's' : ''}.`,
                        code: 'SERVER_LIMIT_REACHED',
                        data: {
                            current: userServerCount,
                            limit: maxServers,
                            plan: userPlan
                        }
                    });
                }
            }
        }

        // Calculate trial end for free users
        const trialEnd = userPlan === 'free'
            ? new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).getTime()
            : null;

        // Build optimized server document
        const serverData = {
            name: name.trim(),
            url: normalizedUrl,
            type,
            description: description.trim(),
            uploadedBy: userId,
            uploadedAt: new Date(),
            uploadedRole: userRole,
            uploadedPlan: userPlan,
            status: 'unknown',
            monitoring: {
                ...buildMonitoringConfig(monitoring, userRole, trialEnd), // Keep existing monitoring config logic
                alerts: {
                    ...monitoring?.alerts,
                    // Force disable advanced alerts for free users
                    email: isPremium ? (monitoring?.alerts?.email ?? true) : true, // Free users get email
                    phone: isPremium ? (monitoring?.alerts?.phone ?? false) : false // Only premium get phone
                }
            },
            contactEmails: sanitizeEmails(contactEmails),
            contactPhones: sanitizePhones(contactPhones),
            priority: priority || 'medium' // Set default priority if not provided
        };

        // Create server
        const server = await Server.create(serverData);

        logger.info(`Server created: ${server.name} (${server._id}) by user ${userId}`, {
            serverType: type,
            userPlan,
            trialEnd: trialEnd ? new Date(trialEnd) : null
        });

        // Return enhanced server data
        const enhancedServer = {
            ...server.toObject(),
            isHealthy: false,
            trialExpired: false,
            nextCheckEstimate: getNextCheckEstimate(server),
            canBeChecked: true
        };

        res.status(201).json({
            status: 'success',
            message: 'Server created successfully',
            data: {
                server: enhancedServer
            }
        });

    } catch (error) {
        logger.error(`Error creating server for user ${userId}: ${error.message}`, {
            requestBody: { name, url, type },
            stack: error.stack
        });

        if (error.name === 'ValidationError') {
            const errors = Object.values(error.errors).map(err => ({
                field: err.path,
                message: err.message,
                value: err.value
            }));

            return res.status(400).json({
                status: 'error',
                message: 'Validation error',
                code: 'VALIDATION_ERROR',
                errors
            });
        }

        res.status(500).json({
            status: 'error',
            message: 'Failed to create server',
            code: 'CREATE_SERVER_ERROR'
        });
    }
});

/**
 * @desc    Update server - BATCH OPTIMIZED
 * @route   PATCH /api/servers/:id
 * @access  Private
 */
export const updateServer = asyncHandler(async (req, res) => {
    const serverId = req.params.id;
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(serverId)) {
        return res.status(400).json({
            status: 'error',
            message: 'Invalid server ID format',
            code: 'INVALID_SERVER_ID'
        });
    }

    try {
        // Find server with minimal projection for auth check
        const server = await Server.findById(serverId, {
            uploadedBy: 1,
            name: 1,
            url: 1
        }).lean();

        if (!server) {
            return res.status(404).json({
                status: 'error',
                message: 'Server not found',
                code: 'SERVER_NOT_FOUND'
            });
        }

        // Authorization check
        if (String(server.uploadedBy) !== String(userId) && !isAdmin) {
            return res.status(403).json({
                status: 'error',
                message: 'Not authorized to update this server',
                code: 'UNAUTHORIZED_UPDATE'
            });
        }

        // Build optimized update object
        const updates = {};
        const {
            name,
            url,
            type,
            description,
            monitoring,
            contactEmails,
            contactPhones,
            priority
        } = req.body;

        // Zod Validation for Update
        const validationResult = updateServerSchema.safeParse(req.body);

        if (!validationResult.success) {
            return res.status(400).json({
                status: 'error',
                message: 'Validation error',
                code: 'VALIDATION_ERROR',
                errors: validationResult.error.errors.map(err => ({
                    field: err.path.join('.'),
                    message: err.message
                }))
            });
        }

        const validatedData = validationResult.data;

        // Map validated data to updates object
        if (validatedData.name) updates.name = validatedData.name;
        if (validatedData.url) {
            const normalizedUrl = normalizeUrl(validatedData.url);
            if (!normalizedUrl) { // Double check url validity
                return res.status(400).json({ status: 'error', message: 'Invalid URL', code: 'INVALID_URL' });
            }

            // Check for duplicate URL (excluding current server) - Logic maintained
            if (normalizedUrl !== server.url) {
                const existingServer = await Server.findOne({
                    uploadedBy: userId,
                    url: normalizedUrl,
                    _id: { $ne: serverId }
                }, { _id: 1 }).lean();

                if (existingServer) {
                    return res.status(400).json({
                        status: 'error',
                        message: 'A server with this URL already exists in your account',
                        code: 'DUPLICATE_URL'
                    });
                }
            }
            updates.url = normalizedUrl;
        }
        if (validatedData.type) updates.type = validatedData.type;
        if (validatedData.description !== undefined) updates.description = validatedData.description; // Allow empty string
        if (validatedData.priority) updates.priority = validatedData.priority;

        if (validatedData.contactEmails) updates.contactEmails = validatedData.contactEmails; // Already validated by Zod
        if (validatedData.contactPhones) updates.contactPhones = validatedData.contactPhones;

        // Handle nested monitoring updates efficiently
        if (monitoring) {
            const monitoringUpdates = buildMonitoringUpdates(monitoring);
            Object.assign(updates, monitoringUpdates);
            logger.info('Monitoring updates processed', {
                serverId,
                receivedMonitoring: monitoring,
                generatedUpdates: monitoringUpdates
            });
        }

        // Set update timestamp
        updates.updatedAt = new Date();

        // Perform atomic update
        const updatedServer = await Server.findByIdAndUpdate(
            serverId,
            { $set: updates },
            {
                new: true,
                runValidators: true,
                select: '-__v'
            }
        );

        logger.info(`Server updated: ${updatedServer.name} (${serverId}) by user ${userId}`, {
            updatedFields: Object.keys(updates)
        });

        // Return enhanced server data
        const enhancedServer = {
            ...updatedServer.toObject(),
            isHealthy: updatedServer.status === 'up' &&
                (!updatedServer.responseTime || updatedServer.responseTime < 2000),
            nextCheckEstimate: getNextCheckEstimate(updatedServer),
            canBeChecked: canBeCheckedNow(updatedServer)
        };

        res.status(200).json({
            status: 'success',
            message: 'Server updated successfully',
            data: {
                server: enhancedServer
            }
        });

    } catch (error) {
        logger.error(`Error updating server ${serverId}: ${error.message}`, {
            userId,
            stack: error.stack
        });

        if (error.name === 'ValidationError') {
            const errors = Object.values(error.errors).map(err => ({
                field: err.path,
                message: err.message,
                value: err.value
            }));

            return res.status(400).json({
                status: 'error',
                message: 'Validation error',
                code: 'VALIDATION_ERROR',
                errors
            });
        }

        res.status(500).json({
            status: 'error',
            message: 'Failed to update server',
            code: 'UPDATE_SERVER_ERROR'
        });
    }
});

/**
 * @desc    Delete server with cleanup - OPTIMIZED
 * @route   DELETE /api/servers/:id
 * @access  Private
 */
export const deleteServer = asyncHandler(async (req, res) => {
    const serverId = req.params.id;
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(serverId)) {
        return res.status(400).json({
            status: 'error',
            message: 'Invalid server ID format',
            code: 'INVALID_SERVER_ID'
        });
    }

    try {
        // Find server with minimal data for auth check
        const server = await Server.findById(serverId, {
            uploadedBy: 1,
            name: 1
        }).lean();

        if (!server) {
            return res.status(404).json({
                status: 'error',
                message: 'Server not found',
                code: 'SERVER_NOT_FOUND'
            });
        }

        // Authorization check
        if (String(server.uploadedBy) !== String(userId) && !isAdmin) {
            return res.status(403).json({
                status: 'error',
                message: 'Not authorized to delete this server',
                code: 'UNAUTHORIZED_DELETE'
            });
        }

        // Get check count for logging
        const checkCount = await ServerCheck.countDocuments({ serverId });

        // Delete server and cleanup checks in parallel
        const [deleteResult] = await Promise.all([
            Server.deleteOne({ _id: serverId }),
            ServerCheck.deleteMany({ serverId }) // Cleanup all associated checks
        ]);

        if (deleteResult.deletedCount === 0) {
            return res.status(404).json({
                status: 'error',
                message: 'Server not found or already deleted',
                code: 'SERVER_NOT_FOUND'
            });
        }

        logger.info(`Server deleted: ${server.name} (${serverId}) by user ${userId}`, {
            checksDeleted: checkCount
        });

        res.status(200).json({
            status: 'success',
            message: 'Server deleted successfully',
            data: {
                deletedServer: {
                    id: serverId,
                    name: server.name
                },
                checksDeleted: checkCount
            }
        });

    } catch (error) {
        logger.error(`Error deleting server ${serverId}: ${error.message}`, {
            userId,
            stack: error.stack
        });

        res.status(500).json({
            status: 'error',
            message: 'Failed to delete server',
            code: 'DELETE_SERVER_ERROR'
        });
    }
});

/**
 * @desc    Manually check server status - ENHANCED
 * @route   POST /api/servers/:id/check
 * @access  Private
 */
export const checkServer = asyncHandler(async (req, res) => {
    const serverId = req.params.id;
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';
    const force = req.body.force === true; // Force check even if recently checked

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(serverId)) {
        return res.status(400).json({
            status: 'error',
            message: 'Invalid server ID format',
            code: 'INVALID_SERVER_ID'
        });
    }

    try {
        // Find server with required fields
        const server = await Server.findById(serverId, {
            uploadedBy: 1,
            name: 1,
            url: 1,
            type: 1,
            status: 1,
            lastChecked: 1,
            timezone: 1,
            monitoring: 1,
            uploadedPlan: 1,
            uploadedRole: 1
        }).lean();

        if (!server) {
            return res.status(404).json({
                status: 'error',
                message: 'Server not found',
                code: 'SERVER_NOT_FOUND'
            });
        }

        // Authorization check
        if (String(server.uploadedBy) !== String(userId) && !isAdmin) {
            return res.status(403).json({
                status: 'error',
                message: 'Not authorized to check this server',
                code: 'UNAUTHORIZED_CHECK'
            });
        }

        // Check if server can be monitored (subscription check)
        if (!canServerBeMonitored(server)) {
            return res.status(403).json({
                status: 'error',
                message: 'Server monitoring trial has expired. Please upgrade your plan.',
                code: 'TRIAL_EXPIRED'
            });
        }

        // Rate limiting check (unless forced)
        if (!force && server.lastChecked) {
            const timeSinceLastCheck = Date.now() - server.lastChecked.getTime();
            const minInterval = 30000; // 30 seconds minimum between manual checks

            if (timeSinceLastCheck < minInterval) {
                const waitTime = Math.ceil((minInterval - timeSinceLastCheck) / 1000);
                return res.status(429).json({
                    status: 'error',
                    message: `Please wait ${waitTime} seconds before checking again`,
                    code: 'RATE_LIMITED',
                    data: {
                        waitTime,
                        lastChecked: server.lastChecked
                    }
                });
            }
        }

        const oldStatus = server.status;
        const now = new Date();
        const checkStartTime = Date.now();

        // Perform the check
        const checkResult = await checkServerStatus(server);
        const checkDuration = Date.now() - checkStartTime;

        // Prepare batch update data
        const updateData = {
            status: checkResult.status,
            responseTime: checkResult.responseTime,
            error: checkResult.error,
            lastChecked: now
        };

        // Only update status change time if status actually changed
        if (oldStatus !== checkResult.status) {
            updateData.lastStatusChange = now;
        }

        // Create enhanced check history document
        const checkDoc = {
            serverId: new mongoose.Types.ObjectId(serverId),
            status: checkResult.status,
            responseTime: checkResult.responseTime,
            error: checkResult.error,
            timestamp: now,
            checkType: 'manual'
        };

        // Execute database operations in parallel
        await Promise.all([
            Server.updateOne({ _id: serverId }, updateData),
            ServerCheck.create(checkDoc)
        ]);

        logger.info(`Manual check completed: ${server.name} (${serverId}) - ${checkResult.status}`, {
            userId,
            oldStatus,
            newStatus: checkResult.status,
            responseTime: checkResult.responseTime,
            checkDuration
        });

        // Publish update to Redis for real-time WebSocket clients
        const updatePayload = {
            serverId: server._id,
            status: checkResult.status || 'unknown',
            latency: checkResult.responseTime,
            lastChecked: now
        };
        redisConnection.publish('monitor-updates', JSON.stringify(updatePayload));

        // Enhanced response with detailed information
        res.status(200).json({
            status: 'success',
            message: 'Server checked successfully',
            data: {
                server: {
                    id: serverId,
                    name: server.name,
                    url: server.url
                },
                check: {
                    status: checkResult.status,
                    responseTime: checkResult.responseTime,
                    error: checkResult.error,
                    timestamp: now,
                    localTime: now.toLocaleString('sv-SE', { timeZone: server.timezone || 'UTC' }).replace('T', ' '),
                    timezone: server.timezone || 'UTC'
                },
                changes: {
                    statusChanged: oldStatus !== checkResult.status,
                    oldStatus,
                    newStatus: checkResult.status
                },
                meta: {
                    checkDuration,
                    checkType: 'manual',
                    forced: force
                }
            }
        });

    } catch (error) {
        logger.error(`Error checking server ${serverId}: ${error.message}`, {
            userId,
            stack: error.stack
        });

        res.status(500).json({
            status: 'error',
            message: 'Failed to check server',
            code: 'CHECK_SERVER_ERROR',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * @desc    Get server check history - FULLY OPTIMIZED
 * @route   GET /api/servers/:id/history
 * @access  Private
 */
export const getServerHistory = asyncHandler(async (req, res) => {
    const serverId = req.params.id;
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';
    const period = req.query.period || '24h';
    const includeStats = req.query.includeStats !== 'false';
    const limit = Math.min(PERFORMANCE_CONFIG.MAX_HISTORY_POINTS, parseInt(req.query.limit) || 300);

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(serverId)) {
        return res.status(400).json({
            status: 'error',
            message: 'Invalid server ID format',
            code: 'INVALID_SERVER_ID'
        });
    }

    try {
        const startTime = Date.now();

        // Check authorization with minimal query
        const server = await Server.findById(serverId, {
            uploadedBy: 1,
            name: 1,
            timezone: 1,
            status: 1
        }).lean();

        if (!server) {
            return res.status(404).json({
                status: 'error',
                message: 'Server not found',
                code: 'SERVER_NOT_FOUND'
            });
        }

        // Check authorization: Ensure IDs are compared as strings
        if (String(server.uploadedBy) !== String(userId) && !isAdmin) {
            return res.status(403).json({
                status: 'error',
                message: 'Not authorized to view server history',
                code: 'UNAUTHORIZED_HISTORY'
            });
        }

        // Calculate time range and sampling based on period
        const { startTimeRange, sampleInterval } = calculateHistoryRange(period);

        // Build aggregation pipeline for efficient history retrieval
        const pipeline = [
            {
                $match: {
                    serverId: new mongoose.Types.ObjectId(serverId),
                    timestamp: { $gte: startTimeRange }
                }
            },
            {
                $sort: { timestamp: -1 } // Sort DESC first to get latest points
            }
        ];

        // Add sampling for large datasets
        if (sampleInterval > 1) {
            pipeline.push({
                $group: {
                    _id: {
                        interval: {
                            $floor: {
                                $divide: [
                                    { $subtract: ['$timestamp', startTimeRange] },
                                    sampleInterval * 60000 // Convert minutes to milliseconds
                                ]
                            }
                        }
                    },
                    status: { $first: '$status' }, // Use first because we sorted DESC (so first is latest)
                    responseTime: { $avg: '$responseTime' },
                    timestamp: { $first: '$timestamp' }, // Use first because we sorted DESC
                    error: { $first: '$error' },
                    count: { $sum: 1 }
                }
            });
        }

        pipeline.push({ $limit: limit });

        // Restore chronological order (ASC) for the graph
        pipeline.push({ $sort: { timestamp: 1 } }); // OR { "_id.interval": 1 } if grouped

        // We need to handle the sort key based on whether we grouped or not
        // If grouped, we sort by timestamp (which we preserved)
        // If not grouped, we sort by timestamp
        // Actually, since we grouped by interval, valid. But wait.
        // If we grouped, the output documents have 'timestamp' field. So { timestamp: 1 } works.

        // Execute history query and stats in parallel if needed
        const [checks, statsResult] = await Promise.all([
            ServerCheck.aggregate(pipeline).allowDiskUse(true),

            includeStats ? ServerCheck.aggregate([
                {
                    $match: {
                        serverId: new mongoose.Types.ObjectId(serverId),
                        timestamp: { $gte: startTimeRange }
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
                        unknownChecks: {
                            $sum: { $cond: [{ $eq: ['$status', 'unknown'] }, 1, 0] }
                        },
                        avgResponseTime: {
                            $avg: {
                                $cond: [
                                    { $and: [{ $eq: ['$status', 'up'] }, { $gt: ['$responseTime', 0] }] },
                                    '$responseTime',
                                    null
                                ]
                            }
                        },
                        minResponseTime: {
                            $min: {
                                $cond: [
                                    { $and: [{ $eq: ['$status', 'up'] }, { $gt: ['$responseTime', 0] }] },
                                    '$responseTime',
                                    null
                                ]
                            }
                        },
                        maxResponseTime: {
                            $max: {
                                $cond: [
                                    { $and: [{ $eq: ['$status', 'up'] }, { $gt: ['$responseTime', 0] }] },
                                    '$responseTime',
                                    null
                                ]
                            }
                        }
                    }
                }
            ]).allowDiskUse(true) : Promise.resolve([])
        ]);

        // Process and format results
        const formattedChecks = checks.map(check => ({
            status: check.status,
            responseTime: Math.round(check.responseTime || 0),
            timestamp: check.timestamp,
            error: check.error,
            ...(check.count && { sampledFrom: check.count })
        }));

        // Calculate comprehensive statistics
        let stats = null;
        if (includeStats && statsResult.length > 0) {
            const result = statsResult[0];
            stats = {
                period,
                totalChecks: result.totalChecks,
                upChecks: result.upChecks,
                downChecks: result.downChecks,
                unknownChecks: result.unknownChecks,
                uptimePercent: result.totalChecks > 0 ?
                    Math.round((result.upChecks / result.totalChecks) * 100 * 10) / 10 : 100,
                avgResponseTime: Math.round(result.avgResponseTime || 0),
                minResponseTime: Math.round(result.minResponseTime || 0),
                maxResponseTime: Math.round(result.maxResponseTime || 0),
                reliability: calculateReliabilityScore(result)
            };
        }

        const queryTime = Date.now() - startTime;
        const timezone = server.timezone || PERFORMANCE_CONFIG.DEFAULT_TIMEZONE;

        res.status(200).json({
            status: 'success',
            data: {
                server: {
                    id: serverId,
                    name: server.name,
                    currentStatus: server.status
                },
                period,
                timezone,
                history: formattedChecks,
                ...(stats && { stats }),
                meta: {
                    dataPoints: formattedChecks.length,
                    queryTime,
                    timeRange: {
                        start: startTimeRange,
                        end: new Date()
                    },
                    sampled: sampleInterval > 1,
                    sampleInterval: sampleInterval > 1 ? `${sampleInterval} minutes` : null
                }
            }
        });

    } catch (error) {
        logger.error(`Error fetching server history ${serverId}: ${error.message}`, {
            userId,
            period,
            stack: error.stack
        });

        res.status(500).json({
            status: 'error',
            message: 'Failed to fetch server history',
            code: 'FETCH_HISTORY_ERROR'
        });
    }
});

/**
 * @desc    Batch check multiple servers - ENHANCED PERFORMANCE
 * @route   POST /api/servers/batch-check
 * @access  Private
 */
export const batchCheckServers = asyncHandler(async (req, res) => {
    const { serverIds, force = false } = req.body;
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';
    const maxConcurrent = Math.min(5, PERFORMANCE_CONFIG.BATCH_CHECK_LIMIT); // Limit concurrent checks

    // Input validation
    if (!Array.isArray(serverIds) || serverIds.length === 0) {
        return res.status(400).json({
            status: 'error',
            message: 'Server IDs array is required',
            code: 'INVALID_INPUT'
        });
    }

    if (serverIds.length > PERFORMANCE_CONFIG.BATCH_CHECK_LIMIT) {
        return res.status(400).json({
            status: 'error',
            message: `Maximum ${PERFORMANCE_CONFIG.BATCH_CHECK_LIMIT} servers can be checked at once`,
            code: 'BATCH_LIMIT_EXCEEDED'
        });
    }

    try {
        const startTime = Date.now();

        // Validate all ObjectIds
        const validIds = serverIds.filter(id => mongoose.Types.ObjectId.isValid(id));

        if (validIds.length !== serverIds.length) {
            return res.status(400).json({
                status: 'error',
                message: `${serverIds.length - validIds.length} invalid server ID(s) found`,
                code: 'INVALID_SERVER_IDS'
            });
        }

        // Find accessible servers
        const servers = await Server.find({
            _id: { $in: validIds },
            ...(isAdmin ? {} : { uploadedBy: userId })
        }).select('name url type status lastChecked timezone monitoring uploadedBy uploadedPlan uploadedRole').lean();

        if (servers.length === 0) {
            return res.status(404).json({
                status: 'error',
                message: 'No accessible servers found',
                code: 'NO_SERVERS_FOUND'
            });
        }

        // Filter servers that can be monitored
        const monitorableServers = servers.filter(server => canServerBeMonitored(server));

        if (monitorableServers.length === 0) {
            return res.status(403).json({
                status: 'error',
                message: 'None of the selected servers can be monitored (trials may have expired)',
                code: 'NO_MONITORABLE_SERVERS'
            });
        }

        // Check rate limits unless forced
        if (!force) {
            const now = Date.now();
            const rateLimitedServers = monitorableServers.filter(server => {
                if (!server.lastChecked) return false;
                const timeSinceLastCheck = now - server.lastChecked.getTime();
                return timeSinceLastCheck < 30000; // 30 seconds
            });

            if (rateLimitedServers.length > 0) {
                return res.status(429).json({
                    status: 'error',
                    message: `${rateLimitedServers.length} servers were checked recently. Use force=true to override.`,
                    code: 'RATE_LIMITED',
                    data: {
                        rateLimitedServers: rateLimitedServers.map(s => ({
                            id: s._id,
                            name: s.name,
                            lastChecked: s.lastChecked
                        }))
                    }
                });
            }
        }

        logger.info(`Starting batch check of ${monitorableServers.length} servers by user ${userId}`, {
            serverIds: monitorableServers.map(s => s._id),
            forced: force
        });

        // Process servers in controlled batches
        const results = await processServersBatched(monitorableServers, maxConcurrent, userId);

        // Compile final results
        const successful = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);
        const totalDuration = Date.now() - startTime;

        logger.info(`Batch check completed: ${successful.length}/${results.length} successful in ${totalDuration}ms`, {
            userId,
            serverCount: results.length,
            successCount: successful.length,
            failureCount: failed.length
        });

        res.status(200).json({
            status: 'success',
            message: `Batch check completed: ${successful.length}/${monitorableServers.length} successful`,
            data: {
                successful,
                failed,
                summary: {
                    total: monitorableServers.length,
                    successful: successful.length,
                    failed: failed.length,
                    duration: totalDuration,
                    averageCheckTime: Math.round(totalDuration / monitorableServers.length)
                }
            }
        });

    } catch (error) {
        logger.error(`Batch check error: ${error.message}`, {
            userId,
            serverIds,
            stack: error.stack
        });

        res.status(500).json({
            status: 'error',
            message: 'Batch check failed',
            code: 'BATCH_CHECK_ERROR'
        });
    }
});

/**
 * @desc    Get server statistics - NEW ENDPOINT
 * @route   GET /api/servers/:id/stats
 * @access  Private
 */
export const getServerStats = asyncHandler(async (req, res) => {
    const serverId = req.params.id;
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';
    const period = req.query.period || '7d';

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(serverId)) {
        return res.status(400).json({
            status: 'error',
            message: 'Invalid server ID format',
            code: 'INVALID_SERVER_ID'
        });
    }

    try {
        // Check authorization
        const server = await Server.findById(serverId, {
            uploadedBy: 1,
            name: 1,
            status: 1,
            createdAt: 1,
            lastChecked: 1,
            responseTime: 1
        }).lean();

        if (!server) {
            return res.status(404).json({
                status: 'error',
                message: 'Server not found',
                code: 'SERVER_NOT_FOUND'
            });
        }

        if (server.uploadedBy !== userId && !isAdmin) {
            return res.status(403).json({
                status: 'error',
                message: 'Not authorized to view server statistics',
                code: 'UNAUTHORIZED_STATS'
            });
        }

        const { startTimeRange } = calculateHistoryRange(period);

        // Get comprehensive statistics
        const [overallStats, dailyStats, hourlyStats] = await Promise.all([
            // Overall statistics
            ServerCheck.aggregate([
                {
                    $match: {
                        serverId: new mongoose.Types.ObjectId(serverId),
                        timestamp: { $gte: startTimeRange }
                    }
                },
                {
                    $group: {
                        _id: null,
                        totalChecks: { $sum: 1 },
                        upChecks: { $sum: { $cond: [{ $eq: ['$status', 'up'] }, 1, 0] } },
                        downChecks: { $sum: { $cond: [{ $eq: ['$status', 'down'] }, 1, 0] } },
                        avgResponseTime: {
                            $avg: {
                                $cond: [
                                    { $and: [{ $eq: ['$status', 'up'] }, { $gt: ['$responseTime', 0] }] },
                                    '$responseTime',
                                    null
                                ]
                            }
                        },
                        maxResponseTime: {
                            $max: {
                                $cond: [
                                    { $and: [{ $eq: ['$status', 'up'] }, { $gt: ['$responseTime', 0] }] },
                                    '$responseTime',
                                    null
                                ]
                            }
                        },
                        minResponseTime: {
                            $min: {
                                $cond: [
                                    { $and: [{ $eq: ['$status', 'up'] }, { $gt: ['$responseTime', 0] }] },
                                    '$responseTime',
                                    null
                                ]
                            }
                        }
                    }
                }
            ]),

            // Daily breakdown
            ServerCheck.aggregate([
                {
                    $match: {
                        serverId: new mongoose.Types.ObjectId(serverId),
                        timestamp: { $gte: startTimeRange }
                    }
                },
                {
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
                        totalChecks: { $sum: 1 },
                        upChecks: { $sum: { $cond: [{ $eq: ['$status', 'up'] }, 1, 0] } },
                        avgResponseTime: {
                            $avg: {
                                $cond: [
                                    { $and: [{ $eq: ['$status', 'up'] }, { $gt: ['$responseTime', 0] }] },
                                    '$responseTime',
                                    null
                                ]
                            }
                        }
                    }
                },
                { $sort: { '_id': 1 } }
            ]),

            // Hourly breakdown for recent data
            ServerCheck.aggregate([
                {
                    $match: {
                        serverId: new mongoose.Types.ObjectId(serverId),
                        timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
                    }
                },
                {
                    $group: {
                        _id: { $dateToString: { format: "%H", date: "$timestamp" } },
                        totalChecks: { $sum: 1 },
                        upChecks: { $sum: { $cond: [{ $eq: ['$status', 'up'] }, 1, 0] } },
                        avgResponseTime: {
                            $avg: {
                                $cond: [
                                    { $and: [{ $eq: ['$status', 'up'] }, { $gt: ['$responseTime', 0] }] },
                                    '$responseTime',
                                    null
                                ]
                            }
                        }
                    }
                },
                { $sort: { '_id': 1 } }
            ])
        ]);

        // Process results
        const overall = overallStats[0] || {
            totalChecks: 0,
            upChecks: 0,
            downChecks: 0,
            avgResponseTime: 0,
            maxResponseTime: 0,
            minResponseTime: 0
        };

        const uptimePercent = overall.totalChecks > 0 ?
            Math.round((overall.upChecks / overall.totalChecks) * 100 * 10) / 10 : 100;

        const dailyBreakdown = dailyStats.map(day => ({
            date: day._id,
            totalChecks: day.totalChecks,
            upChecks: day.upChecks,
            uptimePercent: day.totalChecks > 0 ?
                Math.round((day.upChecks / day.totalChecks) * 100 * 10) / 10 : 100,
            avgResponseTime: Math.round(day.avgResponseTime || 0)
        }));

        const hourlyBreakdown = hourlyStats.map(hour => ({
            hour: hour._id,
            totalChecks: hour.totalChecks,
            upChecks: hour.upChecks,
            uptimePercent: hour.totalChecks > 0 ?
                Math.round((hour.upChecks / hour.totalChecks) * 100 * 10) / 10 : 100,
            avgResponseTime: Math.round(hour.avgResponseTime || 0)
        }));

        res.status(200).json({
            status: 'success',
            data: {
                server: {
                    id: serverId,
                    name: server.name,
                    currentStatus: server.status,
                    lastChecked: server.lastChecked,
                    currentResponseTime: server.responseTime
                },
                period,
                overall: {
                    totalChecks: overall.totalChecks,
                    upChecks: overall.upChecks,
                    downChecks: overall.downChecks,
                    uptimePercent,
                    avgResponseTime: Math.round(overall.avgResponseTime || 0),
                    minResponseTime: Math.round(overall.minResponseTime || 0),
                    maxResponseTime: Math.round(overall.maxResponseTime || 0),
                    reliabilityScore: calculateReliabilityScore(overall)
                },
                breakdowns: {
                    daily: dailyBreakdown,
                    hourly: hourlyBreakdown
                }
            }
        });

    } catch (error) {
        logger.error(`Error fetching server stats ${serverId}: ${error.message}`, {
            userId,
            period,
            stack: error.stack
        });

        res.status(500).json({
            status: 'error',
            message: 'Failed to fetch server statistics',
            code: 'FETCH_STATS_ERROR'
        });
    }
});

// ===============================
// HELPER FUNCTIONS
// ===============================

/**
 * Calculate next check estimate based on server settings
 */
const getNextCheckEstimate = (server) => {
    if (!server.lastChecked) return 'Never checked';

    const frequency = server.monitoring?.frequency || 5; // minutes
    const nextCheck = new Date(server.lastChecked.getTime() + frequency * 60 * 1000);

    if (nextCheck <= new Date()) return 'Due now';

    return nextCheck.toISOString();
};

/**
 * Check if server can be checked now based on monitoring windows
 */
const canBeCheckedNow = (server) => {
    const now = new Date();

    // Check days of week
    if (server.monitoring?.daysOfWeek?.length > 0) {
        if (!server.monitoring.daysOfWeek.includes(now.getDay())) {
            return false;
        }
    }

    // Check time windows
    if (server.monitoring?.timeWindows?.length > 0) {
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const currentTime = `${hours}:${minutes}`;
        const inWindow = server.monitoring.timeWindows.some(window =>
            currentTime >= window.start && currentTime <= window.end
        );
        if (!inWindow) return false;
    }

    return true;
};

/**
 * Check if server can be monitored (subscription check)
 */
const canServerBeMonitored = (server) => {
    // Admin servers always monitored
    if (server.uploadedRole === 'admin' || server.uploadedPlan === 'admin') {
        return true;
    }

    // Check trial expiry for free users
    if (server.uploadedPlan === 'free' &&
        server.monitoring?.trialEndsAt &&
        server.monitoring.trialEndsAt < Date.now()) {
        return false;
    }

    return true;
};

/**
 * Normalize URL for consistency
 */
const normalizeUrl = (url) => {
    try {
        // Remove protocol for consistency
        let normalized = url.replace(/^https?:\/\//, '');

        // Remove trailing slash
        normalized = normalized.replace(/\/$/, '');

        // Basic validation
        if (!normalized || normalized.length < 3) return null;

        return normalized;

    } catch (error) {
        return null;
    }
};

/**
 * Build monitoring configuration
 */
const buildMonitoringConfig = (monitoring, userRole, trialEnd) => {
    return {
        frequency: monitoring.frequency || 5,
        daysOfWeek: monitoring.daysOfWeek || [0, 1, 2, 3, 4, 5, 6],
        timeWindows: monitoring.timeWindows || [{ start: '00:00', end: '23:59' }],
        alerts: {
            enabled: monitoring.alerts?.enabled || false,
            email: monitoring.alerts?.email || false,
            phone: monitoring.alerts?.phone || false,
            responseThreshold: monitoring.alerts?.responseThreshold || 1000,
            timeWindow: monitoring.alerts?.timeWindow || { start: '00:00', end: '23:59' }
        },
        trialEndsAt: userRole === 'admin' ? null : trialEnd
    };
};

/**
 * Build monitoring updates for patch operations
 */
const buildMonitoringUpdates = (monitoring) => {
    const updates = {};

    if (monitoring.frequency !== undefined) {
        updates['monitoring.frequency'] = monitoring.frequency;
    }
    if (monitoring.daysOfWeek !== undefined) {
        updates['monitoring.daysOfWeek'] = monitoring.daysOfWeek;
    }
    if (monitoring.timeWindows !== undefined) {
        updates['monitoring.timeWindows'] = monitoring.timeWindows;
    }

    // Handle alerts
    if (monitoring.alerts) {
        Object.entries(monitoring.alerts).forEach(([key, value]) => {
            if (value !== undefined) {
                updates[`monitoring.alerts.${key}`] = value;
            }
        });
    }

    return updates;
};

/**
 * Sanitize email addresses
 */
const sanitizeEmails = (emails) => {
    if (!Array.isArray(emails)) return [];

    return emails
        .filter(email => email && typeof email === 'string')
        .map(email => email.trim().toLowerCase())
        .filter(email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        .slice(0, 5); // Limit to 5 emails
};

/**
 * Sanitize phone numbers
 */
const sanitizePhones = (phones) => {
    if (!Array.isArray(phones)) return [];

    return phones
        .filter(phone => phone && typeof phone === 'string')
        .map(phone => phone.trim().replace(/\D/g, '')) // Remove non-digits
        .filter(phone => phone.length >= 10 && phone.length <= 15)
        .slice(0, 3); // Limit to 3 phone numbers
};

/**
 * Calculate history range and sampling based on period
 */
const calculateHistoryRange = (period) => {
    const now = new Date();
    let startTimeRange;
    let sampleInterval = 1; // minutes

    switch (period) {
        case '1h':
            startTimeRange = new Date(now.getTime() - 60 * 60 * 1000);
            sampleInterval = 1;
            break;
        case '6h':
            startTimeRange = new Date(now.getTime() - 6 * 60 * 60 * 1000);
            sampleInterval = 2;
            break;
        case '12h':
            startTimeRange = new Date(now.getTime() - 12 * 60 * 60 * 1000);
            sampleInterval = 3;
            break;
        case '24h':
            startTimeRange = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            sampleInterval = 5;
            break;
        case '7d':
            startTimeRange = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            sampleInterval = 30;
            break;
        case '30d':
            startTimeRange = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            sampleInterval = 120;
            break;
        default:
            startTimeRange = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            sampleInterval = 5;
    }

    return { startTimeRange, sampleInterval };
};

/**
 * Calculate reliability score
 */
const calculateReliabilityScore = (stats) => {
    if (!stats.totalChecks) return 100;

    const uptimePercent = (stats.upChecks / stats.totalChecks) * 100;
    const responseScore = stats.avgResponseTime ? Math.max(0, 100 - (stats.avgResponseTime / 50)) : 100;

    return Math.round((uptimePercent * 0.7 + responseScore * 0.3) * 10) / 10;
};

/**
 * Process servers in controlled batches for batch checking
 */
const processServersBatched = async (servers, maxConcurrent, userId) => {
    const results = [];

    // Process servers in chunks to control concurrency
    for (let i = 0; i < servers.length; i += maxConcurrent) {
        const batch = servers.slice(i, i + maxConcurrent);

        const batchPromises = batch.map(async (server) => {
            try {
                const oldStatus = server.status;
                const now = new Date();
                const checkStartTime = Date.now();

                const checkResult = await checkServerStatus(server);
                const checkDuration = Date.now() - checkStartTime;

                // Update server
                const updateData = {
                    status: checkResult.status,
                    responseTime: checkResult.responseTime,
                    error: checkResult.error,
                    lastChecked: now
                };

                if (oldStatus !== checkResult.status) {
                    updateData.lastStatusChange = now;
                }

                const checkDoc = {
                    serverId: server._id,
                    status: checkResult.status,
                    responseTime: checkResult.responseTime,
                    error: checkResult.error,
                    timestamp: now,
                    checkType: 'batch',
                    userId: userId
                };

                // Execute updates in parallel
                await Promise.all([
                    Server.updateOne({ _id: server._id }, updateData),
                    ServerCheck.create(checkDoc)
                ]);

                return {
                    serverId: server._id,
                    name: server.name,
                    url: server.url,
                    status: checkResult.status,
                    responseTime: checkResult.responseTime,
                    error: checkResult.error,
                    statusChanged: oldStatus !== checkResult.status,
                    oldStatus,
                    checkDuration,
                    success: true
                };

            } catch (error) {
                logger.error(`Batch check error for server ${server._id}: ${error.message}`);
                return {
                    serverId: server._id,
                    name: server.name,
                    url: server.url,
                    error: error.message,
                    success: false
                };
            }
        });

        const batchResults = await Promise.allSettled(batchPromises);

        // Process settled results
        batchResults.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                results.push(result.value);
            } else {
                results.push({
                    serverId: batch[index]._id,
                    name: batch[index].name,
                    url: batch[index].url,
                    error: result.reason?.message || 'Unknown error',
                    success: false
                });
            }
        });

        // Brief pause between batches to avoid overwhelming the system
        if (i + maxConcurrent < servers.length) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    return results;
};

export default {
    getServers,
    getServerById,
    createServer,
    updateServer,
    deleteServer,
    checkServer,
    getServerHistory,
    batchCheckServers,
    getServerStats
};