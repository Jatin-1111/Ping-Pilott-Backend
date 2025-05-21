import axios from 'axios';
import net from 'net';
import { setTimeout as sleep } from 'timers/promises';
import logger from '../utils/logger.js';
import Server from '../models/Server.js';
import ServerCheck from '../models/ServerCheck.js';
import { sendAlertEmail } from '../services/emailService.js';
import moment from 'moment-timezone';
import dns from 'dns';
import { promisify } from 'util';

// DNS cache to improve connection times
const dnsCache = new Map();
const dnsLookup = promisify(dns.lookup);

// Enhanced connection pool for HTTP requests
const axiosInstance = axios.create({
    timeout: 10000,
    maxRedirects: 2, // Limit redirects to prevent long chains
    headers: {
        'User-Agent': 'PingPilot-Monitoring/1.0',
        'Connection': 'keep-alive'
    }
});

// In-progress tracking with automatic cleanup (prevent memory leaks)
const inProgressChecks = new Map();
// Auto-cleanup for in-progress checks after 60 seconds (safety net)
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of inProgressChecks.entries()) {
        if (now - value.timestamp > 60000) { // 60 seconds
            inProgressChecks.delete(key);
            logger.warn(`Force-cleared stale in-progress check for server ${key}`);
        }
    }
}, 30000);

// Constants
const HTTP_TIMEOUT = 10000;
const MAX_CONCURRENT_CHECKS = 25; // Increased slightly for better throughput
const TIME_BUFFER_MS = 5000;
const CHECK_BATCH_INTERVAL = 500; // Reduced for faster overall processing

// Server status cache - minimize redundant database operations
const serverStatusCache = new Map();
const SERVER_CACHE_TTL = 60000; // 1 minute

// Optimize time formatting functions
const formatTime = (date) => {
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
};

// Pre-initialize moment timezones to avoid initialization cost during checks
moment.tz.setDefault('UTC');
const commonTimezones = ['Asia/Kolkata', 'UTC', 'America/New_York', 'Europe/London'];
commonTimezones.forEach(tz => moment().tz(tz)); // Warm up timezone data

/**
 * Check all servers that are due for a check
 * @returns {Object} Result statistics
 */
export const checkAllServers = async () => {
    try {
        const startTime = Date.now();
        logger.info(`Starting server check process at ${new Date(startTime).toISOString()}`);

        // Get all servers that need to be checked
        const servers = await getServersToCheck();

        // Skip if no servers to check
        if (!servers || servers.length === 0) {
            logger.info('No servers due for check, skipping process');
            return { total: 0, checked: 0, skipped: 0 };
        }

        logger.info(`Found ${servers.length} servers to check in ${Date.now() - startTime}ms`);

        // Initialize stats object
        const stats = {
            total: servers.length,
            checked: 0,
            up: 0,
            down: 0,
            error: 0,
            skipped: 0,
            alertsSent: 0,
            avgResponseTime: 0,
            totalResponseTime: 0
        };

        // Prioritize servers for checking
        const prioritizedServers = prioritizeServers(servers);

        // Check servers in batches for controlled concurrency
        const batchSize = MAX_CONCURRENT_CHECKS;
        const batches = Math.ceil(prioritizedServers.length / batchSize);

        for (let i = 0; i < batches; i++) {
            const start = i * batchSize;
            const end = Math.min(start + batchSize, prioritizedServers.length);
            const batch = prioritizedServers.slice(start, end);

            // Process this batch in parallel using Promise.all for maximum efficiency
            const promises = batch.map(server => processServer(server, stats));
            await Promise.all(promises);

            // Short sleep between batches to avoid resource spikes
            if (i < batches - 1 && batch.length >= batchSize) {
                await sleep(CHECK_BATCH_INTERVAL);
            }
        }

        // Calculate average response time
        if (stats.checked > 0 && stats.totalResponseTime > 0) {
            stats.avgResponseTime = Math.round(stats.totalResponseTime / stats.checked);
        }

        const totalDuration = Date.now() - startTime;
        logger.info(`Server check process completed in ${totalDuration}ms`, { stats });

        return stats;
    } catch (error) {
        logger.error(`Error in checkAllServers: ${error.message}`);
        throw error;
    }
};

/**
 * Prioritize servers for checking based on criteria
 * @param {Array} servers - List of servers to check
 * @returns {Array} Prioritized server list
 */
const prioritizeServers = (servers) => {
    // Prioritize servers:
    // 1. Servers currently down (higher priority to check if they've recovered)
    // 2. Servers with recent downtime
    // 3. Servers that haven't been checked in a long time
    // 4. Everything else

    return [...servers].sort((a, b) => {
        // Down servers get highest priority
        if (a.status === 'down' && b.status !== 'down') return -1;
        if (a.status !== 'down' && b.status === 'down') return 1;

        // Recently changed status servers get next priority
        if (a.lastStatusChange && b.lastStatusChange) {
            return b.lastStatusChange.getTime() - a.lastStatusChange.getTime();
        }

        // Then sort by last checked time (oldest first)
        if (a.lastChecked && b.lastChecked) {
            return a.lastChecked.getTime() - b.lastChecked.getTime();
        }

        // Never checked servers go first
        if (!a.lastChecked) return -1;
        if (!b.lastChecked) return 1;

        return 0;
    });
};

/**
 * Get servers that are due for a check with optimized query
 * @returns {Array} Servers to check
 */
const getServersToCheck = async () => {
    try {
        const now = new Date();

        // Use lean query for better performance
        const query = {
            $or: [
                { lastChecked: null },
                {
                    $expr: {
                        $gte: [
                            { $subtract: [now, '$lastChecked'] },
                            {
                                $subtract: [
                                    { $multiply: ['$monitoring.frequency', 60 * 1000] },
                                    TIME_BUFFER_MS
                                ]
                            }
                        ]
                    }
                }
            ]
        };

        // Only get needed fields to minimize data transfer
        const fields = {
            name: 1,
            url: 1,
            type: 1,
            status: 1,
            uploadedRole: 1,
            uploadedPlan: 1,
            lastChecked: 1,
            lastStatusChange: 1,
            monitoring: 1,
            timezone: 1,
            error: 1,
            contactEmails: 1,
            responseTime: 1
        };

        // Get all potential servers with efficient query
        const potentialServers = await Server.find(query, fields).lean();

        // Use faster filtering based on timezone using a single loop
        const currentTimeByZone = {};
        const currentDayByZone = {};

        // Filter servers with efficient in-memory checks
        const serversToCheck = potentialServers.filter(server => {
            const timezone = server.timezone || 'Asia/Kolkata';

            // Cache timezone lookup for reuse
            if (!currentTimeByZone[timezone]) {
                const now = moment().tz(timezone);
                currentTimeByZone[timezone] = now.format('HH:mm');
                currentDayByZone[timezone] = now.day();
            }

            const serverTime = currentTimeByZone[timezone];
            const serverDay = currentDayByZone[timezone];

            // Check if today is a monitoring day in server's timezone
            const isDayMatch = !server.monitoring?.daysOfWeek?.length ||
                server.monitoring.daysOfWeek.includes(serverDay);

            if (!isDayMatch) return false;

            // Check if current time is within monitoring window
            if (!server.monitoring?.timeWindows?.length) return true;

            // Special case: If any window is 00:00 to 00:00, treat as 24/7 monitoring
            if (server.monitoring.timeWindows.some(window =>
                window.start === "00:00" && window.end === "00:00")) {
                return true;
            }

            // Check if current time falls within any time window
            return server.monitoring.timeWindows.some(window =>
                serverTime >= window.start && serverTime <= window.end);
        });

        return serversToCheck;
    } catch (error) {
        logger.error(`Error in getServersToCheck: ${error.message}`);
        throw error;
    }
};

/**
 * Process an individual server check
 * @param {Object} server - Server to check
 * @param {Object} stats - Statistics object to update
 */
const processServer = async (server, stats) => {
    const serverId = server._id.toString();

    // Skip if server is already being checked
    if (inProgressChecks.has(serverId)) {
        stats.skipped++;
        return;
    }

    // Mark as in progress with timestamp
    inProgressChecks.set(serverId, { timestamp: Date.now() });

    try {
        // Check if server meets subscription requirements
        if (!shouldMonitorServer(server)) {
            stats.skipped++;
            inProgressChecks.delete(serverId);
            return;
        }

        // Store the previous status for comparison
        const oldStatus = server.status;

        // Check the server status - the core operation
        const checkResult = await checkServerStatus(server);

        // Update statistics
        stats.checked++;
        if (checkResult.status === 'up') stats.up++;
        else if (checkResult.status === 'down') stats.down++;

        if (checkResult.responseTime) {
            stats.totalResponseTime += checkResult.responseTime;
        }

        // Batch update operations for efficiency
        const now = new Date();
        const updateData = {
            status: checkResult.status,
            responseTime: checkResult.responseTime,
            error: checkResult.error,
            lastChecked: now
        };

        // Only set lastStatusChange if status changed
        if (oldStatus !== checkResult.status) {
            updateData.lastStatusChange = now;
        }

        // Create check history document
        const checkDoc = createCheckHistoryDocument(server, checkResult, now);

        // Execute database operations in parallel
        await Promise.all([
            // Update server with one operation
            Server.updateOne({ _id: serverId }, updateData),

            // Save check record
            ServerCheck.create(checkDoc)
        ]);

        // Update server cache
        serverStatusCache.set(serverId, {
            status: checkResult.status,
            timestamp: Date.now()
        });

        // Send alerts if necessary - non-blocking
        if (shouldSendAlert(server, oldStatus, checkResult.status)) {
            // Don't await the alert sending to avoid blocking check process
            sendAlert(server, oldStatus, checkResult.status)
                .then(sent => {
                    if (sent) stats.alertsSent++;
                })
                .catch(err => {
                    logger.error(`Error sending alert for ${server.name}: ${err.message}`);
                });
        }
    } catch (error) {
        logger.error(`Error checking server ${serverId}: ${error.message}`);
        stats.error++;
    } finally {
        // Always clear the in-progress flag, even in error scenarios
        inProgressChecks.delete(serverId);
    }
};

/**
 * Check if a server should be monitored based on subscription status
 * Optimized with early returns
 */
const shouldMonitorServer = (server) => {
    // Early return for admin servers
    if (server.uploadedRole === 'admin' || server.uploadedPlan === 'admin') {
        return true;
    }

    // Check trial status for free users
    return !(
        server.uploadedPlan === 'free' &&
        server.monitoring?.trialEndsAt &&
        server.monitoring.trialEndsAt < Date.now()
    );
};

/**
 * Optimized function to create a check history document
 */
const createCheckHistoryDocument = (server, checkResult, timestamp) => {
    const timezone = server.timezone || 'Asia/Kolkata';
    const localTime = moment(timestamp).tz(timezone);

    return {
        serverId: server._id,
        status: checkResult.status,
        responseTime: checkResult.responseTime,
        error: checkResult.error,
        timestamp: timestamp,
        timezone: timezone,
        localDate: localTime.format('YYYY-MM-DD'),
        localHour: localTime.hour(),
        localMinute: localTime.minute(),
        timeSlot: Math.floor(localTime.minute() / 15)
    };
};

/**
 * Check the status of a server with optimized connection handling
 * @param {Object} server - Server to check
 * @returns {Object} Check result
 */
const checkServerStatus = async (server) => {
    const startTime = Date.now();
    let status = 'unknown';
    let responseTime = null;
    let error = null;

    // Get response threshold from server settings or default to 1000ms
    const responseThreshold = server.monitoring?.alerts?.responseThreshold || 1000;

    try {
        // Different check methods based on server type
        if (server.type === 'tcp') {
            status = await checkTcpServerWithCache(server.url);
        } else {
            status = await checkHttpServerWithCache(server.url);
        }

        // Calculate response time
        responseTime = Date.now() - startTime;

        // Check if response is slow
        if (status === 'up' && responseTime > responseThreshold) {
            error = `Slow response: ${responseTime}ms exceeds threshold of ${responseThreshold}ms`;
        }
    } catch (err) {
        status = 'down';
        error = err.message;
        responseTime = Date.now() - startTime;
    }

    return {
        status,
        responseTime,
        error,
    };
};

/**
 * DNS-cached TCP server check
 */
const checkTcpServerWithCache = async (url) => {
    // Parse host and port from URL
    const [host, portStr] = url.split(':');
    const port = parseInt(portStr, 10) || 80;

    if (!host) {
        throw new Error('Invalid TCP address format (expected host:port)');
    }

    // Use DNS cache to speed up lookups
    let ipAddress;
    if (dnsCache.has(host)) {
        const cacheEntry = dnsCache.get(host);
        // Reuse cache if less than 5 minutes old
        if (Date.now() - cacheEntry.timestamp < 5 * 60 * 1000) {
            ipAddress = cacheEntry.ip;
        }
    }

    // Lookup if not in cache
    if (!ipAddress) {
        try {
            const dnsResult = await dnsLookup(host);
            ipAddress = dnsResult.address;
            dnsCache.set(host, { ip: ipAddress, timestamp: Date.now() });
        } catch (err) {
            throw new Error(`DNS lookup failed: ${err.message}`);
        }
    }

    // Now connect using IP (faster than hostname resolution)
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        let resolved = false;

        // Use closures to avoid memory leaks
        const cleanup = () => {
            if (!resolved) {
                socket.removeAllListeners();
                socket.destroy();
            }
        };

        // Set timeout
        socket.setTimeout(HTTP_TIMEOUT);

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

        // Attempt connection to the resolved IP
        socket.connect(port, ipAddress || host);
    });
};

/**
 * Optimized HTTP server check with connection pooling
 */
const checkHttpServerWithCache = async (url) => {
    // Add protocol if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = `https://${url}`;
    }

    try {
        // Use HEAD request for faster checks where possible
        // Fall back to GET if HEAD fails
        try {
            const response = await axiosInstance.head(url, {
                validateStatus: false, // Don't throw on non-2xx responses
            });

            // Return success for 2xx and 3xx responses
            if (response.status >= 200 && response.status < 400) {
                return 'up';
            }

            // If we get 405 Method Not Allowed, try GET
            if (response.status === 405) {
                throw new Error('HEAD method not allowed');
            }

            throw new Error(`HTTP ${response.status}: ${response.statusText || 'Error'}`);
        } catch (headError) {
            // Fall back to GET if HEAD fails or is not supported
            const response = await axiosInstance.get(url, {
                validateStatus: false, // Don't throw on non-2xx responses
                // Don't download whole content, just headers
                maxContentLength: 1024,
                transformResponse: [(data) => { return {} }]
            });

            // Return success for 2xx and 3xx responses
            if (response.status >= 200 && response.status < 400) {
                return 'up';
            }

            throw new Error(`HTTP ${response.status}: ${response.statusText || 'Error'}`);
        }
    } catch (error) {
        if (error.response) {
            throw new Error(`HTTP ${error.response.status}: ${error.response.statusText || 'Error'}`);
        } else if (error.request) {
            throw new Error(`No response received: ${error.message}`);
        } else {
            throw new Error(`Request error: ${error.message}`);
        }
    }
};

/**
 * Fast check if an alert should be sent
 */
const shouldSendAlert = (server, oldStatus, newStatus) => {
    // Early returns for common cases
    if (!server.monitoring?.alerts?.enabled) return false;

    // Check status change first - most common trigger
    const statusChanged = oldStatus !== newStatus;
    const hasSlowResponse = newStatus === 'up' && server.error &&
        server.error.includes('Slow response');

    if (!statusChanged && !hasSlowResponse) return false;

    // Check time window if needed
    const alertTimeWindow = server.monitoring?.alerts?.timeWindow;
    if (!alertTimeWindow) return true;

    const now = new Date();
    const currentTime = formatTime(now);

    return currentTime >= alertTimeWindow.start &&
        currentTime <= alertTimeWindow.end;
};

/**
 * Optimized alert sending function
 */
const sendAlert = async (server, oldStatus, newStatus) => {
    try {
        // Quick determination of alert type
        let alertType;
        if (oldStatus === 'up' && newStatus === 'down') {
            alertType = 'server_down';
        } else if (oldStatus !== 'up' && newStatus === 'up') {
            alertType = 'server_recovery';
        } else if (newStatus === 'up' && server.error && server.error.includes('Slow response')) {
            alertType = 'slow_response';
        } else {
            return false;
        }

        // Email alerts - only if needed
        if (server.monitoring?.alerts?.email &&
            server.contactEmails?.length > 0) {

            // Use non-awaited call to avoid blocking
            sendAlertEmail(server, alertType, oldStatus, newStatus)
                .catch(err => logger.error(`Email alert error: ${err.message}`));
        }

        return true;
    } catch (error) {
        logger.error(`Error sending alert for server ${server._id}: ${error.message}`);
        return false;
    }
};

// Periodically clean DNS and server status caches
setInterval(() => {
    const now = Date.now();

    // Clean DNS cache (older than 30 minutes)
    for (const [host, data] of dnsCache.entries()) {
        if (now - data.timestamp > 30 * 60 * 1000) {
            dnsCache.delete(host);
        }
    }

    // Clean server status cache (older than TTL)
    for (const [serverId, data] of serverStatusCache.entries()) {
        if (now - data.timestamp > SERVER_CACHE_TTL) {
            serverStatusCache.delete(serverId);
        }
    }
}, 5 * 60 * 1000); // Every 5 minutes

export default { checkAllServers };