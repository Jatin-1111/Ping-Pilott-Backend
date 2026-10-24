// tasks/heartbeat.js - tell a service outside this deployment that monitoring is working
//
// Everything else in this repo checks itself from the inside. If the host dies, or the whole process is stuck, nothing
// is left to say so. A dead-man's-switch service (Healthchecks.io, Better Stack, Uptime Kuma push monitors...) expects
// a ping every few minutes and alerts when they stop. This sends that ping, once a minute, only while the pipeline
// is healthy: a dead worker stops the pings just as a dead host does. Set HEARTBEAT_URL to switch it on.

import axios from 'axios';
import logger from '../utils/logger.js';
import { throttled } from '../utils/logThrottle.js';

export const HEARTBEAT_INTERVAL_MS = 60 * 1000;

/**
 * @param {Object} p
 * @param {string|undefined} p.url         where to ping; nothing happens without it
 * @param {() => Promise<boolean>} p.isHealthy
 * @param {(url: string) => Promise<any>} [p.ping]  replaceable in tests
 * @returns {{ tick: () => Promise<boolean>, stop: () => void } | null}  null when no URL is set
 */
export function startHeartbeat({ url, isHealthy, ping = (target) => axios.get(target, { timeout: 10000, maxRedirects: 2 }), intervalMs = HEARTBEAT_INTERVAL_MS }) {
    if (!url) return null;

    // Resolves true when a ping was sent. Never throws.
    const tick = async () => {
        try {
            if (!(await isHealthy())) return false;
            await ping(url);
            return true;
        } catch (err) {
            // Do not print the address: it usually carries a secret
            throttled('heartbeat-ping', 10 * 60 * 1000, () => logger.warn(`Could not send the monitoring heartbeat: ${err.message}`));
            return false;
        }
    };

    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    logger.info(`Monitoring heartbeat enabled (every ${Math.round(intervalMs / 1000)}s while healthy)`);

    return { tick, stop: () => clearInterval(timer) };
}

export default { startHeartbeat, HEARTBEAT_INTERVAL_MS };
