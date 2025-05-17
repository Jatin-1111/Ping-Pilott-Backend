import axios from 'axios';
import https from 'https';
import http from 'http';
import logger from './logger.js';

// Create HTTP agents with keep-alive
const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 100,
    timeout: 30000 // 30 seconds
});

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 100,
    timeout: 30000, // 30 seconds
    rejectUnauthorized: false // Allow self-signed certificates
});

// Default request timeout in milliseconds
const DEFAULT_TIMEOUT = 10000;

/**
 * Create a configured axios instance with default settings
 * @param {Object} config - Additional axios configuration
 * @returns {Object} Configured axios instance
 */
export const createClient = (config = {}) => {
    return axios.create({
        timeout: DEFAULT_TIMEOUT,
        httpAgent,
        httpsAgent,
        headers: {
            'User-Agent': 'PingPilot-Monitoring/1.0',
            'Accept': 'application/json'
        },
        ...config
    });
};

// Default client instance
const client = createClient();

/**
 * Make a GET request
 * @param {String} url - URL to request
 * @param {Object} config - Optional axios configuration
 * @returns {Promise} Response data
 */
export const get = async (url, config = {}) => {
    try {
        const response = await client.get(url, config);
        return response.data;
    } catch (error) {
        handleRequestError(error, url, 'GET');
        throw error;
    }
};

/**
 * Make a POST request
 * @param {String} url - URL to request
 * @param {Object} data - Request body
 * @param {Object} config - Optional axios configuration
 * @returns {Promise} Response data
 */
export const post = async (url, data = {}, config = {}) => {
    try {
        const response = await client.post(url, data, config);
        return response.data;
    } catch (error) {
        handleRequestError(error, url, 'POST');
        throw error;
    }
};

/**
 * Make a PUT request
 * @param {String} url - URL to request
 * @param {Object} data - Request body
 * @param {Object} config - Optional axios configuration
 * @returns {Promise} Response data
 */
export const put = async (url, data = {}, config = {}) => {
    try {
        const response = await client.put(url, data, config);
        return response.data;
    } catch (error) {
        handleRequestError(error, url, 'PUT');
        throw error;
    }
};

/**
 * Make a DELETE request
 * @param {String} url - URL to request
 * @param {Object} config - Optional axios configuration
 * @returns {Promise} Response data
 */
export const del = async (url, config = {}) => {
    try {
        const response = await client.delete(url, config);
        return response.data;
    } catch (error) {
        handleRequestError(error, url, 'DELETE');
        throw error;
    }
};

/**
 * Handle request errors
 * @param {Error} error - Error object
 * @param {String} url - Request URL
 * @param {String} method - Request method
 */
const handleRequestError = (error, url, method) => {
    if (error.response) {
        // Server responded with an error status code
        logger.error(`HTTP ${method} request failed for ${url}: ${error.response.status} ${error.response.statusText}`);
    } else if (error.request) {
        // Request was made but no response received
        logger.error(`HTTP ${method} request failed for ${url}: No response received - ${error.message}`);
    } else {
        // Error setting up the request
        logger.error(`HTTP ${method} request setup failed for ${url}: ${error.message}`);
    }
};

/**
 * Check if a URL is reachable
 * @param {String} url - URL to check
 * @param {Number} timeout - Request timeout in ms
 * @returns {Promise<Object>} Status and response time
 */
export const checkUrl = async (url, timeout = DEFAULT_TIMEOUT) => {
    const startTime = Date.now();

    try {
        // Add protocol if missing
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = `https://${url}`;
        }

        // Make a HEAD request if possible, fall back to GET
        const response = await client.head(url, {
            timeout,
            validateStatus: false, // Don't throw on any status code
        });

        const responseTime = Date.now() - startTime;

        return {
            status: response.status >= 200 && response.status < 400 ? 'up' : 'down',
            responseTime,
            statusCode: response.status,
            error: response.status >= 400 ? `HTTP ${response.status}` : null
        };
    } catch (error) {
        const responseTime = Date.now() - startTime;

        return {
            status: 'down',
            responseTime,
            statusCode: error.response?.status || null,
            error: error.message
        };
    }
};

export default {
    createClient,
    get,
    post,
    put,
    delete: del,
    checkUrl
};