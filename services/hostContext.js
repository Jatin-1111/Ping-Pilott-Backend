// services/hostContext.js - reads the host agent's recent snapshots for failures that are about to be explained
//
// utils/hostContext.js does the thinking; this only fetches. It never throws: a diagnosis is better without the host
// than not shown, so any failure here (a slow query, a missing collection) gives "no host context".

import HostMetric from '../models/HostMetric.js';
import logger from '../utils/logger.js';
import { hostMetricsEnabled } from '../utils/hostMetrics.js';
import { WINDOW_BEFORE_MS, WINDOW_AFTER_MS, summariseHost } from '../utils/hostContext.js';

const FIELDS = 'timestamp cpu memTotal memUsed swapTotal swapUsed disks procs';
// A minute's snapshots across the window, plus a few spare for an agent that catches up after an outage
const MAX_ROWS = 20;
const QUERY_MS = 1500;

const defaultFind = (serverId, from, to) =>
    HostMetric.find({ serverId, timestamp: { $gte: from, $lte: to } }).select(FIELDS).sort({ timestamp: -1 }).limit(MAX_ROWS).lean().maxTimeMS(QUERY_MS);

/** Whether this server has an agent whose readings could explain a failure, and the plan and flag allow showing them */
export const wantsHostContext = (server, detailed) => Boolean(detailed && hostMetricsEnabled() && server?.agent?.enabled);

/**
 * @param {{ serverId: *, at: Date|number|string|null }} p  the server and when its check failed
 * @param {{ find?: Function }} [deps]
 * @returns {Promise<Object|null>} utils/hostContext.js summariseHost, or null
 */
export async function hostContextFor({ serverId, at }, { find = defaultFind } = {}) {
    const when = new Date(at).getTime();
    if (!serverId || !Number.isFinite(when)) return null;
    try {
        const rows = await find(serverId, new Date(when - WINDOW_BEFORE_MS), new Date(when + WINDOW_AFTER_MS));
        return summariseHost(rows, when);
    } catch (error) {
        logger.warn('Host context unavailable', { serverId: String(serverId), error: error.message });
        return null;
    }
}

export default { wantsHostContext, hostContextFor };
