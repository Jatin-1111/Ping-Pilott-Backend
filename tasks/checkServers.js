// tasks/checkServers.js - Standardized Timezone Logic (UTC/System)

import axios from 'axios';
import net from 'net';
import { setTimeout as sleep } from 'timers/promises';
import logger from '../utils/logger.js';
import Server from '../models/Server.js';
import ServerCheck from '../models/ServerCheck.js';
import { sendAlertEmail } from '../services/emailService.js';

// CONFIGURATION
const CONFIG = {
    MAX_CONCURRENT: 20,
    TIMEOUT: 8000,
    RETRY_ATTEMPTS: 2,
    BATCH_SIZE: 10,
    ADAPTIVE_INTERVALS: {
        up: { base: 5, max: 30 },      // 5-30 min for healthy servers
        down: { base: 1, max: 5 },     // 1-5 min for down servers  
        unknown: { base: 2, max: 10 }   // 2-10 min for unknown
    }
};

// Connection pools for efficiency
const httpAgent = new (await import('http')).Agent({
    keepAlive: true,
    maxSockets: 50,
    timeout: CONFIG.TIMEOUT
});

const httpsAgent = new (await import('https')).Agent({
    keepAlive: true,
    maxSockets: 50,
    timeout: CONFIG.TIMEOUT,
    rejectUnauthorized: false
});

const axiosInstance = axios.create({
    timeout: CONFIG.TIMEOUT,
    httpAgent,
    httpsAgent,
    maxRedirects: 3,
    headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PingPilot/2.0; +https://pingpilot.com/monitoring)'
    }
});

// In-memory tracking
const processingServers = new Set();
const serverStats = new Map(); // Track success/failure rates

/**
 * MAIN: Smart server checking
 */
export const checkAllServersIntelligently = async () => {
    const startTime = Date.now();
    const now = new Date();

    logger.info('🧠 Starting SMART server monitoring...', {
        time: now.toISOString()
    });

    try {
        // Get servers with intelligent prioritization
        const servers = await getServersWithPriority();

        if (!servers?.length) {
            logger.info('No servers need checking right now');
            return { total: 0, checked: 0, skipped: 0 };
        }

        logger.info(`Found ${servers.length} servers to check`);

        const stats = {
            total: servers.length,
            checked: 0,
            up: 0,
            down: 0,
            error: 0,
            skipped: 0,
            alertsSent: 0,
            avgResponseTime: 0,
            totalResponseTime: 0,
            highPriority: servers.filter(s => s.priority === 'high').length,
            mediumPriority: servers.filter(s => s.priority === 'medium').length,
            lowPriority: servers.filter(s => s.priority === 'low').length,
            startTime: now.toISOString()
        };

        // Process in smart batches
        await processServersBatched(servers, stats);

        // Calculate final metrics
        if (stats.checked > 0) {
            stats.avgResponseTime = Math.round(stats.totalResponseTime / stats.checked);
        }

        const duration = Date.now() - startTime;
        stats.completedTime = new Date().toISOString();

        logger.info(`✅ Smart monitoring completed in ${duration}ms`, { stats });

        return stats;

    } catch (error) {
        logger.error(`❌ Smart monitoring error: ${error.message}`);
        throw error;
    }
};

/**
 * Get servers with intelligent prioritization (system time)
 */
const getServersWithPriority = async () => {
    const now = new Date();

    // Smart query - only get servers that ACTUALLY need checking
    const query = {
        $or: [
            { lastChecked: null },
            {
                $expr: {
                    $gte: [
                        { $subtract: [now, '$lastChecked'] },
                        {
                            $multiply: [
                                {
                                    // Strictly follow user's configured frequency
                                    $ifNull: ['$monitoring.frequency', 5]
                                },
                                60000 // Convert to milliseconds
                            ]
                        }
                    ]
                }
            }
        ]
    };

    const servers = await Server.find(query, {
        name: 1,
        url: 1,
        type: 1,
        status: 1,
        lastChecked: 1,
        lastStatusChange: 1,
        monitoring: 1,
        error: 1,
        contactEmails: 1,
        responseTime: 1,
        uploadedRole: 1,
        uploadedPlan: 1,
        priority: 1
    }).lean();

    // Filter by time windows and add priority
    return servers
        .filter(server => isInMonitoringWindow(server, now))
        .filter(server => shouldMonitorServer(server))
        .map(server => ({
            ...server,
            priority: calculatePriority(server)
        }))
        .sort((a, b) => {
            // Sort by priority, then by last check time
            const priorityOrder = { high: 0, medium: 1, low: 2 };
            if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
                return priorityOrder[a.priority] - priorityOrder[b.priority];
            }

            const aTime = a.lastChecked ? a.lastChecked.getTime() : 0;
            const bTime = b.lastChecked ? b.lastChecked.getTime() : 0;
            return aTime - bTime;
        });
};

/**
 * Calculate server priority
 */
/**
 * Calculate server priority
 * Uses user-defined priority as base, escalates for critical states
 */
const calculatePriority = (server) => {
    // 1. Start with user-defined priority (default: medium)
    let priority = server.priority || 'medium';

    // 2. Smart Escalation: DOWN servers need faster checks to detect recovery
    if (server.status === 'down') {
        return 'high';
    }

    // 3. Smart Escalation: Recently changed servers (instability) get high priority
    if (server.lastStatusChange) {
        const hoursSinceChange = (Date.now() - new Date(server.lastStatusChange).getTime()) / (1000 * 60 * 60);
        if (hoursSinceChange < 0.5) { // Changed in last 30 mins
            return 'high';
        }
    }

    return priority;
};

/**
 * Process servers in intelligent batches
 */
const processServersBatched = async (servers, stats) => {
    // Group by priority
    const priorityGroups = {
        high: servers.filter(s => s.priority === 'high'),
        medium: servers.filter(s => s.priority === 'medium'),
        low: servers.filter(s => s.priority === 'low')
    };

    // Process high priority first with larger batches
    for (const [priority, serverList] of Object.entries(priorityGroups)) {
        if (!serverList.length) continue;

        const batchSize = priority === 'high' ? CONFIG.BATCH_SIZE * 2 : CONFIG.BATCH_SIZE;
        const batches = Math.ceil(serverList.length / batchSize);

        logger.info(`Processing ${serverList.length} ${priority} priority servers in ${batches} batches`);

        for (let i = 0; i < batches; i++) {
            const start = i * batchSize;
            const end = Math.min(start + batchSize, serverList.length);
            const batch = serverList.slice(start, end);

            // Process batch in parallel
            const promises = batch.map(server => processServerSmart(server, stats));
            await Promise.allSettled(promises); // Don't let one failure kill the batch

            // Brief pause between batches to avoid overwhelming
            if (i < batches - 1) {
                await sleep(priority === 'high' ? 100 : 200);
            }
        }

        // Longer pause between priority levels
        if (priority !== 'low') {
            await sleep(500);
        }
    }
};

/**
 * Smart individual server processing
 */
const processServerSmart = async (server, stats) => {
    const serverId = server._id.toString();

    // Skip if already processing
    if (processingServers.has(serverId)) {
        stats.skipped++;
        return;
    }

    processingServers.add(serverId);

    try {
        const oldStatus = server.status;

        // Smart check with retries for down servers
        const checkResult = await performSmartCheck(server);

        // Update stats tracking
        updateServerStats(serverId, checkResult.status === 'up');

        // Update counters
        stats.checked++;
        if (checkResult.status === 'up') stats.up++;
        else if (checkResult.status === 'down') stats.down++;

        if (checkResult.responseTime) {
            stats.totalResponseTime += checkResult.responseTime;
        }

        // Batch database updates
        const now = new Date();

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

        // Create check history document
        const checkDoc = {
            serverId: server._id,
            status: checkResult.status,
            responseTime: checkResult.responseTime,
            error: checkResult.error,
            timestamp: now,
            // timezone, localDate etc removed in favor of standard timestamp
        };

        // Execute database operations in parallel
        await Promise.all([
            Server.updateOne({ _id: server._id }, updateData),
            ServerCheck.create(checkDoc)
        ]);

        // Handle alerts asynchronously
        if (shouldSendSmartAlert(server, oldStatus, checkResult.status, checkResult, now)) {
            sendSmartAlert(server, oldStatus, checkResult.status, checkResult, now)
                .then(sent => { if (sent) stats.alertsSent++; })
                .catch(err => logger.error(`Alert error for ${server.name}: ${err.message}`));
        }

    } catch (error) {
        logger.error(`Error checking server ${serverId}: ${error.message}`);
        stats.error++;

        // Update failure stats
        updateServerStats(serverId, false);

    } finally {
        processingServers.delete(serverId);
    }
};

/**
 * Check if server is in monitoring window
 */
const isInMonitoringWindow = (server, now = new Date()) => {
    // If no window defined, always monitor
    if (!server.monitoring?.timeWindows?.length && !server.monitoring?.daysOfWeek?.length) {
        return true;
    }

    const currentDay = now.getDay();
    // Format HH:MM with leading zeros
    const currentTime = now.getHours().toString().padStart(2, '0') + ':' +
        now.getMinutes().toString().padStart(2, '0');

    // Check days of week
    if (server.monitoring?.daysOfWeek?.length > 0) {
        if (!server.monitoring.daysOfWeek.includes(currentDay)) {
            return false;
        }
    }

    // Check time windows
    if (server.monitoring?.timeWindows?.length > 0) {
        // Special case: 00:00 to 00:00 means 24/7
        if (server.monitoring.timeWindows.some(w => w.start === '00:00' && w.end === '00:00')) {
            return true;
        }

        return server.monitoring.timeWindows.some(window =>
            currentTime >= window.start && currentTime <= window.end
        );
    }

    return true;
};

/**
 * Check if server should be monitored
 */
const shouldMonitorServer = (server) => {
    // Admin servers always monitored
    if (server.uploadedRole === 'admin' || server.uploadedPlan === 'admin') {
        return true;
    }

    // Check trial expiry
    if (server.uploadedPlan === 'free' &&
        server.monitoring?.trialEndsAt &&
        new Date(server.monitoring.trialEndsAt) < new Date()) {
        return false;
    }

    return true;
};

/**
 * Smart alert decision making
 */
const shouldSendSmartAlert = (server, oldStatus, newStatus, checkResult, now) => {
    // Basic checks
    if (!server.monitoring?.alerts?.enabled) return false;

    const statusChanged = oldStatus !== newStatus;
    const hasSlowResponse = newStatus === 'up' && checkResult.error?.includes('Slow response');

    if (!statusChanged && !hasSlowResponse) return false;

    // Don't spam alerts for flapping servers
    const stats = getServerStats(server._id.toString());
    if (stats.failureRate > 0.8 && statusChanged) {
        logger.info(`Suppressing alert for flapping server ${server.name} (failure rate: ${stats.failureRate})`);
        return false;
    }

    // Check time window for alerts
    const alertTimeWindow = server.monitoring?.alerts?.timeWindow;
    if (alertTimeWindow) {
        const currentTime = now.getHours().toString().padStart(2, '0') + ':' +
            now.getMinutes().toString().padStart(2, '0');

        if (currentTime < alertTimeWindow.start || currentTime > alertTimeWindow.end) {
            return false;
        }
    }

    return true;
};

/**
 * Send smart alerts
 */
const sendSmartAlert = async (server, oldStatus, newStatus, checkResult, now) => {
    try {
        let alertType;

        if (oldStatus === 'up' && newStatus === 'down') {
            alertType = 'server_down';
        } else if (oldStatus !== 'up' && newStatus === 'up') {
            alertType = 'server_recovery';
        } else if (checkResult.error?.includes('Slow response')) {
            alertType = 'slow_response';
        } else {
            return false;
        }

        // Enhanced server object for email
        const enhancedServer = {
            ...server,
            responseTime: checkResult.responseTime,
            error: checkResult.error,
            attempts: checkResult.attempts,
            alertTime: now.toISOString()
        };

        if (server.monitoring?.alerts?.email && server.contactEmails?.length > 0) {
            await sendAlertEmail(enhancedServer, alertType, oldStatus, newStatus);
            logger.info(`Smart alert sent for ${server.name}: ${alertType}`);
        }

        return true;

    } catch (error) {
        logger.error(`Alert error for ${server.name}: ${error.message}`);
        return false;
    }
};

/**
 * Perform smart check with adaptive strategies
 */
const performSmartCheck = async (server) => {
    const startTime = Date.now();
    const serverStats = getServerStats(server._id.toString());

    // Determine retry count based on server reliability
    const maxRetries = serverStats.failureRate > 0.5 ? CONFIG.RETRY_ATTEMPTS + 1 : CONFIG.RETRY_ATTEMPTS;

    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            logger.debug(`Checking ${server.name} (attempt ${attempt}/${maxRetries})`);

            let status;
            if (server.type === 'tcp') {
                status = await checkTcpSmart(server.url);
            } else {
                status = await checkHttpSmart(server.url, attempt);
            }

            const responseTime = Date.now() - startTime;

            // Check if response is slow
            const threshold = server.monitoring?.alerts?.responseThreshold || 1000;
            let error = null;

            if (status === 'up' && responseTime > threshold) {
                error = `Slow response: ${responseTime}ms exceeds ${threshold}ms threshold`;
            }

            return {
                status,
                responseTime,
                error,
                attempts: attempt
            };

        } catch (err) {
            lastError = err;
            logger.debug(`Attempt ${attempt} failed for ${server.name}: ${err.message}`);

            // Brief delay between retries, increasing with each attempt
            if (attempt < maxRetries) {
                await sleep(attempt * 500);
            }
        }
    }

    // All attempts failed
    return {
        status: 'down',
        responseTime: Date.now() - startTime,
        error: lastError?.message || 'All connection attempts failed',
        attempts: maxRetries
    };
};

/**
 * Smart HTTP checking with multiple strategies
 */
const checkHttpSmart = async (url, attempt = 1) => {
    // Add protocol if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = `https://${url}`;
    }

    // Strategy selection based on attempt number
    const strategies = [
        // Strategy 1: HEAD request (fastest)
        async () => {
            const response = await axiosInstance.head(url, {
                validateStatus: false,
                headers: {
                    'Accept': '*/*',
                    'Cache-Control': 'no-cache'
                }
            });
            return response;
        },

        // Strategy 2: GET request with limited response
        async () => {
            const response = await axiosInstance.get(url, {
                validateStatus: false,
                maxContentLength: 1024 * 5, // 5KB limit
                timeout: CONFIG.TIMEOUT * 0.8,
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
                    'Accept-Encoding': 'gzip, deflate',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                }
            });
            return response;
        },

        // Strategy 3: Different user agent (anti-bot protection)
        async () => {
            const userAgents = [
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
            ];

            const response = await axiosInstance.get(url, {
                validateStatus: false,
                maxContentLength: 1024 * 5,
                timeout: CONFIG.TIMEOUT,
                headers: {
                    'User-Agent': userAgents[attempt % userAgents.length],
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate',
                    'DNT': '1',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                }
            });
            return response;
        }
    ];

    // Use strategy based on attempt number
    const strategy = strategies[Math.min(attempt - 1, strategies.length - 1)];
    const response = await strategy();

    // Success criteria: 2xx, 3xx, or specific 4xx codes that indicate the server is responding
    if (response.status >= 200 && response.status < 400) {
        return 'up';
    }

    // Some 4xx codes still indicate the server is up (just blocking us)
    if ([401, 403, 405, 429].includes(response.status)) {
        return 'up';
    }

    throw new Error(`HTTP ${response.status}: ${response.statusText || 'Error'}`);
};

/**
 * Smart TCP checking (unchanged)
 */
const checkTcpSmart = async (url) => {
    const [host, portStr] = url.split(':');
    const port = parseInt(portStr, 10) || 80;

    if (!host) {
        throw new Error('Invalid TCP address format');
    }

    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        let resolved = false;

        const cleanup = () => {
            if (!resolved && socket) {
                socket.removeAllListeners();
                socket.destroy();
            }
        };

        socket.setTimeout(CONFIG.TIMEOUT);

        socket.on('connect', () => {
            cleanup();
            resolved = true;
            resolve('up');
        });

        socket.on('timeout', () => {
            cleanup();
            resolved = true;
            reject(new Error('Connection timeout'));
        });

        socket.on('error', (err) => {
            cleanup();
            resolved = true;
            reject(err);
        });

        socket.connect(port, host);
    });
};

/**
 * Update server statistics for smart decision making (unchanged)
 */
const updateServerStats = (serverId, success) => {
    if (!serverStats.has(serverId)) {
        serverStats.set(serverId, {
            totalChecks: 0,
            failures: 0,
            failureRate: 0,
            lastUpdated: Date.now()
        });
    }

    const stats = serverStats.get(serverId);
    stats.totalChecks++;
    if (!success) stats.failures++;
    stats.failureRate = stats.failures / stats.totalChecks;
    stats.lastUpdated = Date.now();

    // Keep only recent stats (last 100 checks max)
    if (stats.totalChecks > 100) {
        stats.totalChecks = Math.floor(stats.totalChecks * 0.9);
        stats.failures = Math.floor(stats.failures * 0.9);
        stats.failureRate = stats.failures / stats.totalChecks;
    }
};

/**
 * Get server statistics (unchanged)
 */
const getServerStats = (serverId) => {
    return serverStats.get(serverId) || {
        totalChecks: 0,
        failures: 0,
        failureRate: 0,
        lastUpdated: 0
    };
};

// Cleanup old stats periodically
setInterval(() => {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;

    for (const [serverId, stats] of serverStats.entries()) {
        if (now - stats.lastUpdated > oneHour) {
            serverStats.delete(serverId);
        }
    }

    processingServers.clear(); // Safety cleanup

    if (serverStats.size > 0) {
        logger.debug(`Stats cleanup: ${serverStats.size} servers being tracked`);
    }
}, 10 * 60 * 1000); // Every 10 minutes

export default { checkAllServersIntelligently };