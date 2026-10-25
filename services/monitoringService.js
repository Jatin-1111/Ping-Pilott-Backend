// services/monitoringService.js - uptime checks with connection pooling, SSRF protection and honest errors
import axios from 'axios';
import net from 'net';
import { performance } from 'perf_hooks';
import logger from '../utils/logger.js';
import { TimedHttpAgent, TimedHttpsAgent, timedRequest, connectTimings } from '../utils/requestTiming.js';
import { classifyFailure, failureOf, HttpStatusError, InvalidAddressError } from '../utils/failures.js';
import {
    safeLookup,
    assertPublicHost,
    blockPrivateRedirect,
    hostFromTarget,
    allowPrivateTargets
} from '../utils/ssrfGuard.js';

// HTTP timeout in milliseconds (10 seconds)
const HTTP_TIMEOUT = 10000;

// Every check opens a fresh connection. A server is checked once a minute at most, so a pooled socket would almost
// never be reused, and when it was the check skipped the TCP and TLS handshakes and looked faster than the one before
// it. (A socket the server had already dropped also showed up as a spurious ECONNRESET.)
// `lookup: safeLookup` makes every connection refuse private addresses, whatever the hostname resolves to at that moment.
// Certificates are not validated on purpose: this tool reports "does it answer", and self-signed
// staging servers should not show as down.
// The agents also note how long each step of a connection took (utils/requestTiming.js).
const httpAgent = new TimedHttpAgent({
    keepAlive: false,
    maxSockets: 100,
    timeout: HTTP_TIMEOUT,
    lookup: safeLookup
});

const httpsAgent = new TimedHttpsAgent({
    keepAlive: false,
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
 * @returns {Object} { status, responseTime, error, slow, timings, statusCode, failure }
 *   responseTime is only set for a successful check; a failure has no meaningful response time.
 *   failure is { kind, statusCode? } for a failed check (kind: see utils/failures.js) and null otherwise; `error` is
 *   still the sentence for the user. statusCode is the HTTP status the server answered with, when it answered.
 *   timings says where it went: { dns, connect, tls, ttfb, redirects } in ms (a TCP check has dns and connect only).
 *   It is the time the request that succeeded took: DNS, connect, TLS and the wait for the response headers (and any
 *   redirects). The address safety check before it, and a HEAD that failed before the GET that worked, are not in it.
 *   `slow` is this one check against the threshold; whether to alert on it is decided over several checks (utils/alertDecision.js).
 */
export const checkServerStatus = async (server) => {
    const responseThreshold = server.monitoring?.alerts?.responseThreshold || 1000;

    let measured;
    try {
        // TCP and database servers are plain socket checks. (Databases do not speak HTTP.)
        if (server.type === 'tcp' || server.type === 'database') {
            measured = await checkTcpServer(server.url);
        } else {
            measured = await checkHttpServer(server.url);
        }
    } catch (err) {
        const classified = classifyFailure(err, { timeoutSeconds: HTTP_TIMEOUT / 1000 });
        return {
            status: 'down',
            responseTime: null,
            error: classified.message,
            slow: false,
            timings: null,
            statusCode: classified.statusCode,
            failure: failureOf(classified)
        };
    }

    // At least 1: a response time of 0 reads as "no data" in the feed and the charts
    const responseTime = Math.max(1, measured.ms);
    const slow = responseTime > responseThreshold;

    return {
        status: 'up',
        responseTime,
        error: slow ? `Slow response: ${responseTime}ms exceeds threshold of ${responseThreshold}ms` : null,
        slow,
        timings: measured.timings ?? null,
        statusCode: measured.status ?? null,
        failure: null
    };
};

/**
 * Check a TCP server (also used for databases)
 * @param {String} url - host:port or scheme://host[:port]
 * @returns {Promise<{ ms: number, timings: { dns: number, connect: number } }>} Resolves with the time the connection took, rejects if it fails
 */
export const checkTcpServer = async (url) => {
    const { host, port } = parseTcpTarget(url);

    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new InvalidAddressError();
    }
    // IP literals skip DNS, so they need the explicit check; hostnames are covered by `lookup` below (one lookup per check)
    await assertPublicHost(host, { resolve: false });

    return new Promise((resolve, reject) => {
        const hop = { startedAt: performance.now(), lookupAt: null };
        const socket = net.connect({ host, port, lookup: safeLookup });
        socket.once('lookup', () => { hop.lookupAt = performance.now(); }); // not for an IP address
        let settled = false;

        const finish = (err) => {
            if (settled) return;
            settled = true;
            const endedAt = performance.now();
            socket.destroy();
            err ? reject(err) : resolve({ ms: Math.round(endedAt - hop.startedAt), timings: connectTimings(hop, endedAt) });
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
 * The time reported is the request that answered, not the HEAD that was turned away before it.
 * @returns {Promise<{ status: number, method: 'HEAD'|'GET', ms: number, timings: Object|null }>}
 */
const attempt = async (targetUrl) => {
    const headers = { ...BROWSER_HEADERS };

    let head = null;
    try {
        head = await timedRequest(() => monitoringAxios.head(targetUrl, { headers }));
    } catch (err) {
        // A timeout or unreachable host will not improve with a second request
        if (err.code !== 'ECONNRESET') throw err;
    }

    if (head && head.response.status >= 200 && head.response.status < 400) {
        return { status: head.response.status, method: 'HEAD', ms: head.ms, timings: head.timings };
    }

    // The stream resolves when the headers arrive, which is when the clock stops
    const get = await timedRequest(() => monitoringAxios.get(targetUrl, { headers, responseType: 'stream' }));
    get.response.data.destroy(); // headers are enough
    if (get.response.status >= 200 && get.response.status < 400) {
        return { status: get.response.status, method: 'GET', ms: get.ms, timings: get.timings };
    }

    throw new HttpStatusError(get.response.status, get.response.statusText);
};

/**
 * Check an HTTP/HTTPS server
 * @param {String} url - stored address; may or may not include a scheme
 * @returns {Promise<{ status: number, method: string, ms: number, timings: Object|null }>} Resolves if the server answers with a 2xx/3xx, rejects otherwise
 */
export const checkHttpServer = async (url) => {
    const hasScheme = /^https?:\/\//i.test(url);
    const primary = hasScheme ? url : `https://${url}`;

    // IP literals skip DNS, so they need the explicit check; hostnames are covered by the agent's `lookup` (one lookup per check)
    await assertPublicHost(primary, { resolve: false });

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
