import axios from 'axios';
import net from 'net';
import logger from '../utils/logger.js';

// HTTP timeout in milliseconds (10 seconds)
const HTTP_TIMEOUT = 10000;

/**
 * Check the status of a server
 * @param {Object} server - Server to check
 * @returns {Object} Check result with status, responseTime, and error
 */
export const checkServerStatus = async (server) => {
    const startTime = Date.now();
    let status = 'unknown';
    let responseTime = null;
    let error = null;

    // Get response threshold from server settings or default to 1000ms
    const responseThreshold = server.monitoring?.alerts?.responseThreshold || 1000;

    try {
        logger.debug(`Checking server ${server.name} (${server.url})`);

        // Different check methods based on server type
        if (server.type === 'tcp') {
            // For TCP servers, use socket connection
            try {
                await checkTcpServer(server.url);
                status = 'up';
            } catch (err) {
                status = 'down';
                error = err.message;
            }
        } else {
            // For HTTP/HTTPS resources, use axios
            try {
                await checkHttpServer(server.url);
                status = 'up';
            } catch (err) {
                status = 'down';
                error = err.message;
            }
        }

        // Calculate response time
        responseTime = Date.now() - startTime;

        // Check if response is slow
        if (status === 'up' && responseTime > responseThreshold) {
            error = `Slow response: ${responseTime}ms exceeds threshold of ${responseThreshold}ms`;
        }

        logger.debug(`Check result for ${server.name}: ${status}, ${responseTime}ms${error ? ', ' + error : ''}`);

        return {
            status,
            responseTime,
            error
        };
    } catch (err) {
        responseTime = Date.now() - startTime;
        logger.error(`Error checking server ${server.name}: ${err.message}`);

        return {
            status: 'down',
            responseTime,
            error: err.message
        };
    }
};

/**
 * Check a TCP server
 * @param {String} url - TCP server address (host:port)
 * @returns {Promise} Resolves if connection succeeds, rejects if it fails
 */
export const checkTcpServer = (url) => {
    return new Promise((resolve, reject) => {
        try {
            // Parse host and port from URL
            let host, port;

            if (url.includes(':')) {
                [host, port] = url.split(':');
                port = parseInt(port, 10);
            } else {
                host = url;
                port = 80; // Default to HTTP port
            }

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
                    resolve();
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
 * @returns {Promise} Resolves if connection succeeds, rejects if it fails
 */
export const checkHttpServer = async (url) => {
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
            return true;
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
 * Get stats for a server over a time period
 * @param {String} serverId - Server ID
 * @param {String} period - Time period (1h, 6h, 12h, 24h, 7d, 30d)
 * @returns {Object} Server stats
 */
export const getServerStats = async (serverId, period = '24h') => {
    // Implementation would be similar to getServerHistory in serverController
    // This is a placeholder for a potential future method
};

export default {
    checkServerStatus,
    checkTcpServer,
    checkHttpServer,
    getServerStats
};