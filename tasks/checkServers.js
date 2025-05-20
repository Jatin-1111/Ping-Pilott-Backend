import axios from 'axios';
import net from 'net';
import { setTimeout as sleep } from 'timers/promises';
import logger from '../utils/logger.js';
import Server from '../models/Server.js';
import ServerCheck from '../models/ServerCheck.js';
import { sendAlertEmail } from '../services/emailService.js';

// Create a map to track in-progress checks
const inProgressChecks = new Map();

// HTTP timeout in milliseconds (10 seconds)
const HTTP_TIMEOUT = 10000;

// Maximum concurrent checks
const MAX_CONCURRENT_CHECKS = 20;

/**
 * Check all servers that are due for a check
 * @returns {Object} Result statistics
 */
export const checkAllServers = async () => {
    try {
        logger.info('Starting server check process');
        console.log('[TROUBLESHOOTING] Starting server check process at', new Date().toISOString());

        // Get all servers that need to be checked
        console.log('[TROUBLESHOOTING] Fetching servers that need to be checked');
        const servers = await getServersToCheck();
        logger.info(`Found ${servers.length} servers to check`);
        console.log(`[TROUBLESHOOTING] Found ${servers.length} servers to check`);

        // Log server IDs for troubleshooting
        if (servers.length > 0) {
            console.log('[TROUBLESHOOTING] Server IDs:', servers.map(s => s._id).join(', '));
        }

        // Initialize stats object
        const stats = {
            total: servers.length,
            checked: 0,
            up: 0,
            down: 0,
            error: 0,
            skipped: 0,
            alertsSent: 0
        };

        // Check servers in batches to avoid overwhelming resources
        const batchSize = MAX_CONCURRENT_CHECKS;
        const batches = Math.ceil(servers.length / batchSize);

        for (let i = 0; i < batches; i++) {
            const start = i * batchSize;
            const end = Math.min(start + batchSize, servers.length);
            const batch = servers.slice(start, end);

            logger.info(`Processing batch ${i + 1}/${batches} (${batch.length} servers)`);
            console.log(`[TROUBLESHOOTING] Processing batch ${i + 1}/${batches} (${batch.length} servers)`);

            // Process this batch in parallel
            const promises = batch.map(server => processServer(server, stats));
            await Promise.all(promises);

            // Short sleep between batches to avoid resource spikes
            if (i < batches - 1) {
                await sleep(1000);
            }

            // Log intermediate stats
            console.log(`[TROUBLESHOOTING] Batch ${i + 1} completed. Current stats:`, JSON.stringify(stats));
        }

        logger.info('Server check process completed', { stats });
        console.log('[TROUBLESHOOTING] Server check process completed', JSON.stringify(stats));
        return stats;

    } catch (error) {
        logger.error(`Error in checkAllServers: ${error.message}`);
        console.error(`[TROUBLESHOOTING] Error in checkAllServers: ${error.message}`);
        console.error('[TROUBLESHOOTING] Error stack:', error.stack);
        throw error;
    }
};

/**
 * Get servers that are due for a check
 * @returns {Array} Servers to check
 */
const getServersToCheck = async () => {
    try {
        const now = new Date();
        console.log(`[TROUBLESHOOTING] Current time for checking: ${now.toISOString()}`);
        console.log(`[TROUBLESHOOTING] Day of week: ${now.getDay()}, Time: ${formatTime(now)}`);

        // Find servers that:
        // 1. Have never been checked, OR
        // 2. Are due for a check based on frequency setting
        const query = {
            $or: [
                { lastChecked: null },
                {
                    $expr: {
                        $gt: [
                            { $subtract: [now, '$lastChecked'] },
                            { $multiply: ['$monitoring.frequency', 60 * 1000] } // frequency in minutes to ms
                        ]
                    }
                }
            ]
        };

        // Only check servers within their monitoring days and time windows
        query.$and = [
            // Check if today is a monitoring day
            {
                $or: [
                    { 'monitoring.daysOfWeek': { $exists: false } },
                    { 'monitoring.daysOfWeek': { $size: 0 } },
                    { 'monitoring.daysOfWeek': now.getDay() }
                ]
            },
            // Check if current time is within the monitoring time window
            {
                $or: [
                    { 'monitoring.timeWindows': { $exists: false } },
                    { 'monitoring.timeWindows': { $size: 0 } },
                    {
                        'monitoring.timeWindows': {
                            $elemMatch: {
                                start: { $lte: formatTime(now) },
                                end: { $gte: formatTime(now) }
                            }
                        }
                    }
                ]
            }
        ];

        console.log(`[TROUBLESHOOTING] Query for getServersToCheck:`, JSON.stringify(query));

        const servers = await Server.find(query).sort({ lastChecked: 1 });
        console.log(`[TROUBLESHOOTING] Found ${servers.length} servers matching query`);

        return servers;
    } catch (error) {
        logger.error(`Error in getServersToCheck: ${error.message}`);
        console.error(`[TROUBLESHOOTING] Error in getServersToCheck: ${error.message}`);
        console.error('[TROUBLESHOOTING] Error stack:', error.stack);
        throw error;
    }
};

/**
 * Format time as HH:MM
 * @param {Date} date - Date object
 * @returns {String} Time in HH:MM format
 */
const formatTime = (date) => {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
};

/**
 * Process an individual server
 * @param {Object} server - Server to check
 * @param {Object} stats - Statistics object to update
 */
const processServer = async (server, stats) => {
    // Skip if server is already being checked
    if (inProgressChecks.get(server.id)) {
        logger.warn(`Server ${server.id} check already in progress, skipping`);
        console.log(`[TROUBLESHOOTING] Server ${server.id} (${server.name}) check already in progress, skipping`);
        stats.skipped++;
        return;
    }

    // Mark as in progress
    inProgressChecks.set(server.id, true);
    console.log(`[TROUBLESHOOTING] Starting check for server ${server.id} (${server.name}) at ${new Date().toISOString()}`);

    try {
        logger.debug(`Checking server ${server.name} (${server.url})`);

        // Check if server meets subscription requirements
        if (!shouldMonitorServer(server)) {
            logger.debug(`Skipping check for server ${server.name} due to subscription constraints`);
            console.log(`[TROUBLESHOOTING] Skipping check for server ${server.name} due to subscription constraints`);
            stats.skipped++;
            return;
        }

        // Store the previous status for comparison
        const oldStatus = server.status;
        console.log(`[TROUBLESHOOTING] Server ${server.name} previous status: ${oldStatus}`);

        // Check the server status
        const startTime = Date.now();
        const checkResult = await checkServerStatus(server);
        const checkDuration = Date.now() - startTime;

        console.log(`[TROUBLESHOOTING] Server ${server.name} check result: ${JSON.stringify(checkResult)} (took ${checkDuration}ms)`);

        // Update server with check results
        server.status = checkResult.status;
        server.responseTime = checkResult.responseTime;
        server.error = checkResult.error;
        server.lastChecked = new Date();

        // If status changed, record the change time
        if (oldStatus !== checkResult.status) {
            server.lastStatusChange = new Date();
            console.log(`[TROUBLESHOOTING] Server ${server.name} status changed from ${oldStatus} to ${checkResult.status}`);
        }

        // Save server updates
        console.log(`[TROUBLESHOOTING] Saving updated server ${server.id} (${server.name})`);
        await server.save();
        console.log(`[TROUBLESHOOTING] Server ${server.id} (${server.name}) saved successfully`);

        // Record check history
        console.log(`[TROUBLESHOOTING] Recording check history for server ${server.id} (${server.name})`);
        await recordCheckHistory(server, checkResult);
        console.log(`[TROUBLESHOOTING] Check history recorded successfully for server ${server.id} (${server.name})`);

        // Update stats
        stats.checked++;
        stats[checkResult.status]++;

        // Send alerts if necessary
        if (shouldSendAlert(server, oldStatus, checkResult.status)) {
            console.log(`[TROUBLESHOOTING] Sending alert for server ${server.name}`);
            const alertSent = await sendAlert(server, oldStatus, checkResult.status);
            if (alertSent) {
                stats.alertsSent++;
                console.log(`[TROUBLESHOOTING] Alert sent successfully for server ${server.name}`);
            } else {
                console.log(`[TROUBLESHOOTING] Failed to send alert for server ${server.name}`);
            }
        }

        logger.debug(`Server ${server.name} check completed: ${checkResult.status}`);
        console.log(`[TROUBLESHOOTING] Server ${server.name} check completed: ${checkResult.status}`);

    } catch (error) {
        logger.error(`Error checking server ${server.id}: ${error.message}`);
        console.error(`[TROUBLESHOOTING] Error checking server ${server.id} (${server.name}): ${error.message}`);
        console.error('[TROUBLESHOOTING] Error stack:', error.stack);
        stats.error++;
    } finally {
        // Mark as no longer in progress
        inProgressChecks.set(server.id, false);
        console.log(`[TROUBLESHOOTING] Completed processing server ${server.id} (${server.name})`);
    }
};

/**
 * Check if a server should be monitored based on subscription status
 * @param {Object} server - Server to check
 * @returns {Boolean} Whether to monitor this server
 */
const shouldMonitorServer = (server) => {
    // If server was added by admin or with an admin plan, always monitor
    if (server.uploadedRole === 'admin' || server.uploadedPlan === 'admin') {
        return true;
    }

    // Check if trial has ended for free users
    if (
        server.monitoring?.trialEndsAt &&
        server.monitoring.trialEndsAt < Date.now() &&
        server.uploadedPlan === 'free'
    ) {
        return false;
    }

    return true;
};

/**
 * Check the status of a server
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
            // For TCP servers, use socket connection
            status = await checkTcpServer(server.url, responseThreshold);
        } else {
            // For HTTP/HTTPS resources, use axios
            status = await checkHttpServer(server.url, responseThreshold);
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
 * Check a TCP server
 * @param {String} url - TCP server address (host:port)
 * @param {Number} threshold - Response time threshold
 * @returns {String} Status ('up' or 'down')
 */
const checkTcpServer = (url, threshold) => {
    return new Promise((resolve, reject) => {
        try {
            // Parse host and port from URL
            const [host, portStr] = url.split(':');
            const port = parseInt(portStr, 10) || 80;

            if (!host) {
                return reject(new Error('Invalid TCP address format (expected host:port)'));
            }

            const socket = new net.Socket();
            let resolved = false;

            // Set timeout
            socket.setTimeout(HTTP_TIMEOUT);

            socket.on('connect', () => {
                socket.end();
                if (!resolved) {
                    resolved = true;
                    resolve('up');
                }
            });

            socket.on('timeout', () => {
                socket.destroy();
                if (!resolved) {
                    resolved = true;
                    reject(new Error('Connection timeout'));
                }
            });

            socket.on('error', (err) => {
                if (!resolved) {
                    resolved = true;
                    reject(err);
                }
            });

            // Attempt connection
            socket.connect(port, host);

        } catch (err) {
            reject(err);
        }
    });
};

/**
 * Check an HTTP/HTTPS server
 * @param {String} url - HTTP server URL
 * @param {Number} threshold - Response time threshold
 * @returns {String} Status ('up' or 'down')
 */
const checkHttpServer = async (url, threshold) => {
    try {
        // Add protocol if missing
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = `https://${url}`;
        }

        // Make HTTP request
        const response = await axios.get(url, {
            timeout: HTTP_TIMEOUT,
            headers: {
                'User-Agent': 'PingPilot-Monitoring/1.0'
            },
            validateStatus: false // Don't throw on non-2xx responses
        });

        // Consider 2xx and 3xx responses as up
        if (response.status >= 200 && response.status < 400) {
            return 'up';
        } else {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
    } catch (error) {
        if (error.response) {
            throw new Error(`HTTP ${error.response.status}: ${error.response.statusText}`);
        } else if (error.request) {
            throw new Error(`No response received: ${error.message}`);
        } else {
            throw new Error(`Request error: ${error.message}`);
        }
    }
};

/**
 * Record server check history in database
 * @param {Object} server - Server object
 * @param {Object} checkResult - Check result
 */
// Modified recordCheckHistory function from tasks/checkServers.js

const recordCheckHistory = async (server, checkResult) => {
    try {
        const now = new Date();
        console.log(`[TROUBLESHOOTING] Creating check history record for server ${server.id} (${server.name}) at ${now.toISOString()}`);

        // Create new check record
        const check = new ServerCheck({
            serverId: server.id,
            status: checkResult.status,
            responseTime: checkResult.responseTime,
            error: checkResult.error,
            timestamp: now,
            date: now.toISOString().split('T')[0], // YYYY-MM-DD
            hour: now.getHours(),
            minute: now.getMinutes(),
            timeSlot: Math.floor(now.getMinutes() / 15), // 15-minute slots (0-3)
        });

        console.log(`[TROUBLESHOOTING] ServerCheck object created: ${JSON.stringify(check)}`);

        // Save the check record
        await check.save();
        console.log(`[TROUBLESHOOTING] ServerCheck saved successfully with ID: ${check._id}`);

        // Verify the record was created by retrieving it
        try {
            const savedCheck = await ServerCheck.findById(check._id);
            if (savedCheck) {
                console.log(`[TROUBLESHOOTING] Successfully verified ServerCheck record creation: ${savedCheck._id}`);
            } else {
                console.log(`[TROUBLESHOOTING] WARNING: Could not verify ServerCheck record creation for ID: ${check._id}`);
            }
        } catch (verifyError) {
            console.error(`[TROUBLESHOOTING] Error verifying ServerCheck record: ${verifyError.message}`);
        }

        // Count total records for this server for troubleshooting
        try {
            const count = await ServerCheck.countDocuments({ serverId: server.id });
            console.log(`[TROUBLESHOOTING] Total check records for server ${server.id} (${server.name}): ${count}`);
        } catch (countError) {
            console.error(`[TROUBLESHOOTING] Error counting ServerCheck records: ${countError.message}`);
        }

        return check._id;
    } catch (error) {
        logger.error(`Error recording check history for server ${server.id}: ${error.message}`);
        console.error(`[TROUBLESHOOTING] Error recording check history for server ${server.id} (${server.name}): ${error.message}`);
        console.error('[TROUBLESHOOTING] Error stack:', error.stack);

        // Attempt to get more details about the error
        if (error.name === 'ValidationError') {
            for (const field in error.errors) {
                console.error(`[TROUBLESHOOTING] Validation error for field ${field}: ${error.errors[field].message}`);
            }
        }

        // Non-critical error, don't throw to allow the process to continue
        return null;
    }
};

/**
 * Determine if an alert should be sent
 * @param {Object} server - Server object
 * @param {String} oldStatus - Previous status
 * @param {String} newStatus - New status
 * @returns {Boolean} Whether to send an alert
 */
const shouldSendAlert = (server, oldStatus, newStatus) => {
    // Skip if alerts are disabled
    if (!server.monitoring?.alerts?.enabled) {
        return false;
    }

    // Check if we're within the alert time window
    const now = new Date();
    const currentTime = formatTime(now);
    const alertTimeWindow = server.monitoring?.alerts?.timeWindow;

    if (
        alertTimeWindow &&
        (currentTime < alertTimeWindow.start || currentTime > alertTimeWindow.end)
    ) {
        logger.debug(`Alert time window check failed: ${currentTime} not in ${alertTimeWindow.start}-${alertTimeWindow.end}`);
        return false;
    }

    // Send alert on status change or slow response
    return (
        // Status changed
        oldStatus !== newStatus ||
        // Or status is 'up' but response is slow
        (newStatus === 'up' && server.error && server.error.includes('Slow response'))
    );
};

/**
 * Send alert for server status change
 * @param {Object} server - Server object
 * @param {String} oldStatus - Previous status
 * @param {String} newStatus - New status
 * @returns {Boolean} Whether alert was sent
 */
const sendAlert = async (server, oldStatus, newStatus) => {
    try {
        logger.info(`Sending alert for server ${server.name}: ${oldStatus} -> ${newStatus}`);

        // Different alert types
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

        // Email alerts
        if (server.monitoring?.alerts?.email && server.contactEmails?.length > 0) {
            await sendAlertEmail(server, alertType, oldStatus, newStatus);
        }

        // Future: Add SMS/call alerts, webhooks, etc.

        return true;
    } catch (error) {
        logger.error(`Error sending alert for server ${server.id}: ${error.message}`);
        return false;
    }
};

export default { checkAllServers };