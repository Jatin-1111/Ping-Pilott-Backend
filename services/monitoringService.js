// services/monitoringService.js - uptime checks with connection pooling, SSRF protection and honest errors
import axios from 'axios';
import net from 'net';
import http from 'http';
import https from 'https';
import logger from '../utils/logger.js';
import {
    safeLookup,
    assertPublicHost,
    blockPrivateRedirect,
    hostFromTarget,
    PrivateTargetError,
    allowPrivateTargets
} from '../utils/ssrfGuard.js';

// HTTP timeout in milliseconds (10 seconds)
const HTTP_TIMEOUT = 10000;

// Connection pools for efficiency and reuse. `lookup: safeLookup` makes every connection refuse
// private addresses, whatever the hostname resolves to at that moment.
// Certificates are not validated on purpose: this tool reports "does it answer", and self-signed
// staging servers should not show as down.
const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 100,
    timeout: HTTP_TIMEOUT,
    lookup: safeLookup
});

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 100,
    timeout: HTTP_TIMEOUT,
    rejectUnauthorized: false,
    lookup: safeLookup
});

// Create configured axios instance
const monitoringAxios = axios.create({
    timeout: HTTP_TIMEOUT,
    httpAgent,
    httpsAgent,
    maxRedirects: 5,
    beforeRedirect: blockPrivateRedirect,
    validateStatus: () => true // judge the status ourselves; never throw on 4xx/5xx
});

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; PingPilott/1.0; +https://pingpilott.com)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5'
};

/** Turn low-level errors into a short message a user can act on. */
const describeError = (err) => {
    if (err instanceof PrivateTargetError || err?.code === 'PRIVATE_TARGET') return err.message;
    switch (err?.code) {
        case 'ECONNREFUSED': return 'Connection refused';
        case 'ECONNRESET': return 'Connection reset by the server';
        case 'ENOTFOUND':
        case 'EAI_AGAIN': return 'DNS lookup failed (host not found)';
        case 'ETIMEDOUT':
        case 'ECONNABORTED':
        case 'ERR_CANCELED': return `Timed out after ${HTTP_TIMEOUT / 1000}s`;
        case 'EHOSTUNREACH':
        case 'ENETUNREACH': return 'Host unreachable';
        default: return err?.message || 'Request failed';
    }
};

/** Default ports for connection-style addresses such as postgres://host. */
const SCHEME_PORTS = { postgres: 5432, postgresql: 5432, mysql: 3306, mongodb: 27017, redis: 6379, http: 80, https: 443 };

/** "db.example.com:5432", "postgres://db.example.com", "[::1]:80" -> { host, port } */
const parseTcpTarget = (target) => {
    const raw = String(target).trim();
    const scheme = (raw.match(/^([a-z][a-z0-9+.-]*):\/\//i) || [])[1]?.toLowerCase();
    try {
        const url = new URL(scheme ? raw : `tcp://${raw}`);
        const port = url.port ? parseInt(url.port, 10) : (scheme && SCHEME_PORTS[scheme]) || 80;
        return { host: url.hostname.replace(/^\[|\]$/g, ''), port };
    } catch {
        return { host: '', port: NaN };
    }
};

/**
 * Check the status of a server
 * @param {Object} server - Server to check
 * @returns {Object} { status, responseTime, error, slow }
 *   responseTime is only set for a successful check; a failure has no meaningful response time.
 */
export const checkServerStatus = async (server) => {
    const startTime = Date.now();
    const responseThreshold = server.monitoring?.alerts?.responseThreshold || 1000;

    try {
        // TCP and database servers are plain socket checks. (Databases do not speak HTTP.)
        if (server.type === 'tcp' || server.type === 'database') {
            await checkTcpServer(server.url);
        } else {
            await checkHttpServer(server.url);
        }
    } catch (err) {
        return {
            status: 'down',
            responseTime: null,
            error: describeError(err),
            slow: false
        };
    }

    const responseTime = Date.now() - startTime;
    const slow = responseTime > responseThreshold;

    return {
        status: 'up',
        responseTime,
        error: slow ? `Slow response: ${responseTime}ms exceeds threshold of ${responseThreshold}ms` : null,
        slow
    };
};

/**
 * Check a TCP server (also used for databases)
 * @param {String} url - host:port or scheme://host[:port]
 * @returns {Promise} Resolves if connection succeeds, rejects if it fails
 */
export const checkTcpServer = async (url) => {
    const { host, port } = parseTcpTarget(url);

    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Invalid address (expected host:port)');
    }
    // IP literals skip DNS, so they need the explicit check; hostnames are covered by `lookup` below
    await assertPublicHost(host);

    return new Promise((resolve, reject) => {
        const socket = net.connect({ host, port, lookup: safeLookup });
        let settled = false;

        const finish = (err) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            err ? reject(err) : resolve();
        };

        socket.setTimeout(HTTP_TIMEOUT);
        socket.once('connect', () => finish());
        socket.once('timeout', () => finish(Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' })));
        socket.once('error', (err) => finish(err));
    });
};

/**
 * One HTTP attempt. HEAD first (cheap); some servers answer HEAD wrongly, so a 4xx/5xx or reset
 * on HEAD is retried as GET. The GET only reads the response headers and then drops the body,
 * so a large page can never turn into a false "down".
 */
const attempt = async (targetUrl) => {
    const headers = { ...BROWSER_HEADERS };

    let response;
    try {
        response = await monitoringAxios.head(targetUrl, { headers });
    } catch (err) {
        // A timeout or unreachable host will not improve with a second request
        if (err.code !== 'ECONNRESET') throw err;
    }

    if (response && response.status >= 200 && response.status < 400) return response.status;

    const get = await monitoringAxios.get(targetUrl, { headers, responseType: 'stream' });
    get.data.destroy(); // headers are enough
    if (get.status >= 200 && get.status < 400) return get.status;

    throw new Error(`HTTP ${get.status}${get.statusText ? `: ${get.statusText}` : ''}`);
};

/**
 * Check an HTTP/HTTPS server
 * @param {String} url - stored address; may or may not include a scheme
 * @returns {Promise} Resolves if the server answers with a 2xx/3xx, rejects otherwise
 */
export const checkHttpServer = async (url) => {
    const hasScheme = /^https?:\/\//i.test(url);
    const primary = hasScheme ? url : `https://${url}`;

    // IP literals skip DNS, so they need the explicit check; hostnames are covered by the agent's `lookup`
    await assertPublicHost(primary);

    try {
        return await attempt(primary);
    } catch (err) {
        // The address was saved without a scheme: https is tried first, then plain http for sites that have no TLS.
        // Only connection-level failures justify this; a real HTTP error from the https site is a real answer.
        const connectionLevel = ['ECONNREFUSED', 'ECONNRESET', 'EPROTO', 'ERR_SSL_WRONG_VERSION_NUMBER'].includes(err?.code);
        if (!hasScheme && connectionLevel) {
            try {
                return await attempt(`http://${url}`);
            } catch {
                // fall through and report the original (https) failure
            }
        }
        throw err;
    }
};

export { hostFromTarget, allowPrivateTargets };

export default {
    checkServerStatus,
    checkTcpServer,
    checkHttpServer
};
