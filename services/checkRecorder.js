// services/checkRecorder.js - the one place a finished check is applied to a server
// Used by the scheduled worker and by manual and batch checks, so every path alerts the same way.
// (Before, a manual check that flipped a server to "down" saved the new status without an alert, and the
// worker then saw "down -> down" and never sent one.)

import Server from '../models/Server.js';
import { addAlertToQueue } from '../queues/alertQueue.js';
import PendingAlert from '../models/PendingAlert.js';
import { enqueueAlert } from './alertOutbox.js';
import { redisConnection } from '../config/redis.js';
import { planCheckUpdate } from '../utils/alertDecision.js';
import { invalidateServerCache } from '../utils/cacheManager.js';
import { recordStatusChange } from './incidentService.js';

/**
 * Save a check result on the server, tell the owner if it matters, and publish it for live clients.
 *
 * The update is a compare-and-set: it only applies if the server is still in the state the caller read.
 * If two checks of the same server race, only one wins, and only the winner queues the alert.
 * An alert is therefore never sent for a status change that failed to save.
 *
 * @param {Object} server - lean server doc with: _id, name, status, slowAlerted, slowStreak, fastStreak, alertedStatus,
 *                          statusChanges, flapHeldAt, priority, monitoring, contactEmails, contactPhones, uploadedBy
 *                          (a path that does not select the flap fields would overwrite them with an empty history)
 * @param {Object} checkResult - { status, responseTime, error, slow }
 * @param {Object} [options]
 * @param {'automated'|'manual'|'batch'} [options.checkType] - only 'automated' (the scheduled worker) moves the slow-alert
 *   counters, so a person pressing "Check now" cannot open or close a slow alert
 * @returns {{ now: Date, changed: boolean, previous: string, applied: boolean }}
 */
export async function applyCheckResult(server, checkResult, { checkType = 'automated' } = {}) {
    const now = new Date();
    const previous = server.status;
    const { filter, $set, alertType, changed, slowStreak, flap } = planCheckUpdate({ server, checkResult, checkType, now });

    const result = await Server.updateOne(filter, { $set });
    const applied = result.matchedCount === 1;

    // The owner's cached server list now shows an outdated status
    if (changed && applied) await invalidateServerCache(String(server.uploadedBy));

    // Going down opens an incident and recovering closes it. Only the check that won the update records it.
    if (changed && applied) await recordStatusChange(server, previous, checkResult, now);

    // The alert is saved before it is queued, so a queue that is down or an email provider that is slow cannot lose it
    if (alertType && applied) {
        // A slow alert says how many checks in a row it took, not just the one that tipped it. The alert that starts or
        // ends a flap hold says so too: the same alert types, with the context in their text.
        const alertResult = {
            ...checkResult,
            ...(alertType === 'slow_response' ? { slowStreak } : {}),
            ...(flap ? { flap } : {})
        };
        await enqueueAlert({ server, alertType, previous, checkResult: alertResult }, { model: PendingAlert, queue: { add: addAlertToQueue } });
    }

    redisConnection.publish('monitor-updates', JSON.stringify({
        serverId: server._id,
        userId: server.uploadedBy,
        status: checkResult.status || 'unknown',
        latency: checkResult.responseTime,
        serverTime: Number.isFinite(checkResult.serverTime) ? Math.round(checkResult.serverTime) : null,
        error: checkResult.error,
        lastChecked: now
    }));

    return { now, changed, previous, applied };
}

export default { applyCheckResult };
