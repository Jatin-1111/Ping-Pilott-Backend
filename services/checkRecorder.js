// services/checkRecorder.js - the one place a finished check is applied to a server
// Used by the scheduled worker and by manual and batch checks, so every path alerts the same way.
// (Before, a manual check that flipped a server to "down" saved the new status without an alert, and the
// worker then saw "down -> down" and never sent one.)

import Server from '../models/Server.js';
import { addAlertToQueue } from '../queues/alertQueue.js';
import { redisConnection } from '../config/redis.js';
import { decideAlert } from '../utils/alertDecision.js';
import { invalidateServerCache } from '../utils/cacheManager.js';
import logger from '../utils/logger.js';

/**
 * Save a check result on the server, tell the owner if it matters, and publish it for live clients.
 *
 * The update is a compare-and-set: it only applies if the server is still in the state the caller read.
 * If two checks of the same server race, only one wins, and only the winner queues the alert.
 * An alert is therefore never sent for a status change that failed to save.
 *
 * @param {Object} server - lean server doc with: _id, name, status, slowAlerted, priority, monitoring,
 *                          contactEmails, contactPhones, uploadedBy
 * @param {Object} checkResult - { status, responseTime, error, slow }
 * @returns {{ now: Date, changed: boolean, previous: string, applied: boolean }}
 */
export async function applyCheckResult(server, checkResult) {
    const now = new Date();
    const previous = server.status;
    const changed = previous !== checkResult.status;
    const alertType = decideAlert(previous, checkResult, server.slowAlerted === true);

    const $set = {
        status: checkResult.status,
        responseTime: checkResult.responseTime,
        error: checkResult.error,
        lastChecked: now,
        // an open slow-alert stays open while the server stays slow, and closes when it speeds up or goes down
        slowAlerted: checkResult.status === 'up' && !!checkResult.slow
    };
    if (changed) $set.lastStatusChange = now;

    const filter = { _id: server._id };
    if (changed) filter.status = previous;
    else if (alertType === 'slow_response') filter.slowAlerted = { $ne: true };

    const result = await Server.updateOne(filter, { $set });
    const applied = result.matchedCount === 1;

    // The owner's cached server list now shows an outdated status
    if (changed && applied) await invalidateServerCache(String(server.uploadedBy));

    if (alertType && applied) {
        try {
            await addAlertToQueue({
                serverId: server._id.toString(),
                alertType,
                oldStatus: previous,
                newStatus: checkResult.status,
                checkResult,
                serverData: server
            }, server.priority === 'high' ? 'high' : 'normal');
        } catch (err) {
            logger.error(`Failed to queue alert for ${server.name}: ${err.message}`);
        }
    }

    redisConnection.publish('monitor-updates', JSON.stringify({
        serverId: server._id,
        userId: server.uploadedBy,
        status: checkResult.status || 'unknown',
        latency: checkResult.responseTime,
        error: checkResult.error,
        lastChecked: now
    }));

    return { now, changed, previous, applied };
}

export default { applyCheckResult };
