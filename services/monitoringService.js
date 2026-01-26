// services/monitoringService.js - Optimized with Connection Pooling & Browser Headers
import axios from 'axios';
import net from 'net';
import http from 'http';
import https from 'https';
import logger from '../utils/logger.js';

// HTTP timeout in milliseconds (10 seconds)
const HTTP_TIMEOUT = 10000;

// Connection pools for efficiency and reuse
const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 100, // Handle more concurrency
    timeout: HTTP_TIMEOUT
});

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 100,
    timeout: HTTP_TIMEOUT,
    rejectUnauthorized: false
});

// Create configured axios instance
const monitoringAxios = axios.create({
    timeout: HTTP_TIMEOUT,
    httpAgent,
    httpsAgent,
    maxRedirects: 5,
    validateStatus: false
});

// More realistic browser user agents
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0'
];

// Get random user agent
const getRandomUserAgent = () => {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
};

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
        // logger.debug(`Checking server ${server.name} (${server.url})`);

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
            // For HTTP/HTTPS resources, use axios with browser headers
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

        // logger.debug(`Check result for ${server.name}: ${status}, ${responseTime}ms${error ? ', ' + error : ''}`);

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

            const cleanup = () => {
                if (!resolved && socket) {
                    socket.removeAllListeners();
                    socket.destroy();
                }
            };

            socket.on('connect', () => {
                cleanup();
                resolved = true;
                resolve();
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

            // Attempt connection
            socket.connect(port, host);

        } catch (err) {
            reject(err);
        }
    });
};

/**
 * Check an HTTP/HTTPS server with browser-like headers
 * @param {String} url - HTTP server URL
 * @returns {Promise} Resolves if connection succeeds, rejects if it fails
 */
export const checkHttpServer = async (url) => {
    try {
        // Add protocol if missing
        let targetUrl = url;
        if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
            targetUrl = `https://${targetUrl}`;
        }

        // Try multiple strategies to avoid bot detection
        const strategies = [
            // Strategy 1: HEAD request with browser headers (Optimized)
            async () => {
                const response = await monitoringAxios.head(targetUrl, {
                    headers: {
                        'User-Agent': getRandomUserAgent(),
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'DNT': '1',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1',
                        'Cache-Control': 'max-age=0'
                    }
                });
                return response;
            },

            // Strategy 2: GET request with browser headers (fallback for HEAD failures)
            async () => {
                const response = await monitoringAxios.get(targetUrl, {
                    headers: {
                        'User-Agent': getRandomUserAgent(),
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'DNT': '1',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1',
                        'Cache-Control': 'max-age=0'
                    },
                    maxContentLength: 1024 * 10, // Limit to 10KB
                    transformResponse: [(data) => data] // Don't parse response
                });
                return response;
            }
        ];

        let lastError;

        // Try each strategy
        for (const strategy of strategies) {
            try {
                const response = await strategy();

                // Consider 2xx and 3xx responses as up
                if (response.status >= 200 && response.status < 400) {
                    return true;
                }

                // For 403, try the next strategy
                if (response.status === 403) {
                    lastError = new Error(`HTTP ${response.status}: Forbidden - trying alternative approach`);
                    continue;
                }

                // For other errors, throw immediately
                throw new Error(`HTTP ${response.status}: ${response.statusText || 'Error'}`);

            } catch (error) {
                lastError = error;

                // If it's a 405 Method Not Allowed on HEAD, try GET
                if (error.response?.status === 405) {
                    continue;
                }

                // If it's a 403, try the next strategy
                if (error.response?.status === 403) {
                    continue;
                }

                // For other errors, try next strategy or throw
                if (strategies.indexOf(strategy) === strategies.length - 1) {
                    throw error;
                }
            }
        }

        // If we get here, all strategies failed
        throw lastError || new Error('All connection strategies failed');

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

export default {
    checkServerStatus,
    checkTcpServer,
    checkHttpServer
};