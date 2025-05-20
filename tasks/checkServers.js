import axios from 'axios';
import net from 'net';
import { setTimeout as sleep } from 'timers/promises';
import logger from '../utils/logger.js';
import Server from '../models/Server.js';
import ServerCheck from '../models/ServerCheck.js';
import { sendAlertEmail } from '../services/emailService.js';
import moment from 'moment-timezone';

// Create a map to track in-progress checks
const inProgressChecks = new Map();

// HTTP timeout in milliseconds (10 seconds)
const HTTP_TIMEOUT = 10000;

// Maximum concurrent checks
const MAX_CONCURRENT_CHECKS = 20;

// Time buffer in milliseconds to ensure we don't miss checks
// This ensures we check slightly earlier than exactly frequency minutes
const TIME_BUFFER_MS = 5000; // 5 seconds buffer

const formatTime = (date) => {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
};

const formatTimeInTimezone = (date, timezone) => {
    return moment(date).tz(timezone || 'Asia/Kolkata').format('HH:mm');
};

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
        logger.info(`Found ${servers.length} servers to check in ${Date.now() - startTime}ms`);

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
            const batchStartTime = Date.now();
            const start = i * batchSize;
            const end = Math.min(start + batchSize, servers.length);
            const batch = servers.slice(start, end);

            logger.info(`Processing batch ${i + 1}/${batches} (${batch.length} servers)`);

            // Process this batch in parallel
            const promises = batch.map(server => processServer(server, stats));
            await Promise.all(promises);

            // Short sleep between batches to avoid resource spikes
            if (i < batches - 1) {
                await sleep(1000);
            }
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
 * Get servers that are due for a check
 * @returns {Array} Servers to check
 */
const getServersToCheck = async () => {
    try {
        const queryStart = Date.now();
        const now = new Date();

        // Base query for servers due for checking
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

        // Get all potential servers
        const potentialServers = await Server.find(query);

        // Filter servers based on their own timezone settings
        const serversToCheck = potentialServers.filter(server => {
            const serverTimezone = server.timezone || 'Asia/Kolkata';
            const serverNow = moment().tz(serverTimezone);
            const serverDay = serverNow.day(); // 0-6, where 0 is Sunday
            const serverTime = serverNow.format('HH:mm');

            // Check if today is a monitoring day in server's timezone
            const isDayMatch = !server.monitoring?.daysOfWeek?.length ||
                server.monitoring.daysOfWeek.includes(serverDay);

            // Check if current time is within the monitoring window in server's timezone
            let isTimeMatch = true;
            if (server.monitoring?.timeWindows?.length) {
                // Special case: If start time equals end time (00:00 to 00:00), treat as 24/7 monitoring
                const has24x7Window = server.monitoring.timeWindows.some(window =>
                    window.start === "00:00" && window.end === "00:00");

                if (!has24x7Window) {
                    isTimeMatch = server.monitoring.timeWindows.some(window =>
                        serverTime >= window.start && serverTime <= window.end);
                }
            }

            return isDayMatch && isTimeMatch;
        });

        return serversToCheck;
    } catch (error) {
        logger.error(`Error in getServersToCheck: ${error.message}`);
        throw error;
    }
};

/**
 * Process an individual server
 * @param {Object} server - Server to check
 * @param {Object} stats - Statistics object to update
 */
const processServer = async (server, stats) => {
    const serverId = server._id || server.id;
    const serverStart = Date.now();

    // Skip if server is already being checked
    if (inProgressChecks.get(serverId)) {
        logger.warn(`Server ${serverId} check already in progress, skipping`);
        stats.skipped++;
        return;
    }

    // Mark as in progress
    inProgressChecks.set(serverId, true);

    try {
        logger.debug(`Checking server ${server.name} (${server.url})`);

        // Check if server meets subscription requirements
        if (!shouldMonitorServer(server)) {
            logger.debug(`Skipping check for server ${server.name} due to subscription constraints`);
            stats.skipped++;
            inProgressChecks.set(serverId, false); // Important: always clear the in-progress flag
            return;
        }

        // Store the previous status for comparison
        const oldStatus = server.status;

        // Check the server status
        const checkStart = Date.now();
        const checkResult = await checkServerStatus(server);
        const checkDuration = Date.now() - checkStart;

        // Update server with check results
        server.status = checkResult.status;
        server.responseTime = checkResult.responseTime;
        server.error = checkResult.error;
        server.lastChecked = new Date(); // Use precise timestamp for when the check completed

        // If status changed, record the change time
        if (oldStatus !== checkResult.status) {
            server.lastStatusChange = new Date();
        }

        // Save server updates
        const saveStart = Date.now();
        await server.save();

        // Record check history
        const historyStart = Date.now();
        await recordCheckHistory(server, checkResult);

        // Update stats
        stats.checked++;
        if (checkResult.status === 'up') stats.up++;
        else if (checkResult.status === 'down') stats.down++;

        // Send alerts if necessary
        if (shouldSendAlert(server, oldStatus, checkResult.status)) {
            const alertStart = Date.now();
            const alertSent = await sendAlert(server, oldStatus, checkResult.status);

            if (alertSent) {
                stats.alertsSent++;
            } else {
            }
        }

        logger.debug(`Server ${server.name} check completed: ${checkResult.status}`);

    } catch (error) {
        logger.error(`Error checking server ${serverId}: ${error.message}`);
        stats.error++;
    } finally {
        // CRITICAL: Always mark as no longer in progress, even in error scenarios
        inProgressChecks.set(serverId, false);
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

const recordCheckHistory = async (server, checkResult) => {
    try {

        // Get server's timezone
        const timezone = server.timezone || 'Asia/Kolkata';

        // Convert to server's timezone for storage
        const localTime = moment(now).tz(timezone);

        // Create new check record with proper timezone data
        const check = new ServerCheck({
            serverId: server.id,
            status: checkResult.status,
            responseTime: checkResult.responseTime,
            error: checkResult.error,
            timestamp: now,
            timezone: timezone,
            localDate: localTime.format('YYYY-MM-DD'),
            localHour: localTime.hour(),
            localMinute: localTime.minute(),
            timeSlot: Math.floor(localTime.minute() / 15) // 15-minute slots (0-3)
        });


        // Save the check record
        await check.save();

        // Verify the record was created by retrieving it
        try {
            const savedCheck = await ServerCheck.findById(check._id);
        } catch (verifyError) {
            console.error(`[TROUBLESHOOTING] Error verifying ServerCheck record: ${verifyError.message}`);
        }

        return check._id;
    } catch (error) {
        logger.error(`Error recording check history for server ${server.id}: ${error.message}`);

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
            sendAlertEmail(server, alertType, oldStatus, newStatus);
        }

        // Future: Add SMS/call alerts, webhooks, etc.

        return true;
    } catch (error) {
        logger.error(`Error sending alert for server ${server.id}: ${error.message}`);
        return false;
    }
};

export default { checkAllServers };