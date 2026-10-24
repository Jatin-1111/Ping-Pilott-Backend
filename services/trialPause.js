// services/trialPause.js - stop monitoring cleanly when a free trial ends, and tell the owner
//
// When a free trial ended the scheduler just skipped the server. Nothing else changed: its last status stayed on the
// dashboard (green for ever, or red with an incident that never closed), the scheduler read it again every minute, and
// the owner was never told. Now, once per server:
//   1. it is paused: status unknown, open incident closed, next check moved out of the scheduler's reach
//   2. the owner gets one email saying why and how to resume
// Upgrading to a paid plan clears the pause (services/planService.js).
//
// The models and the mailer are parameters, so this runs in tests without a database or SMTP.

import logger from '../utils/logger.js';

/** The scheduler looks for servers due at or before now; this is never reached */
export const NEVER = new Date('2999-01-01T00:00:00.000Z');

const BATCH = 200;
/** A notice that could not be sent is retried for this long */
export const NOTICE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Free-plan servers whose trial has ended and that have not been paused yet */
export const expiredTrialFilter = (now) => ({
    uploadedPlan: 'free',
    uploadedRole: { $ne: 'admin' },
    pausedAt: null,
    'monitoring.trialEndsAt': { $lt: now }
});

/**
 * @param {Object} p
 * @param {Object} p.servers    Server model
 * @param {Object} p.incidents  Incident model
 * @param {Object} p.users      User model
 * @param {(user, servers: Array) => Promise<boolean>} p.sendNotice  email one owner; true when sent
 * @param {(server) => Promise<void>} [p.onPaused]  tell live dashboards and clear caches; failures are ignored
 * @returns {Promise<{ paused: number, notified: number }>}
 */
export async function pauseExpiredTrials({ servers, incidents, users, sendNotice, onPaused = async () => {}, now = new Date() }) {
    let paused = 0;

    const expired = await servers.find(expiredTrialFilter(now)).select('_id uploadedBy name').limit(BATCH).lean();
    for (const candidate of expired) {
        // Claim it: only one scheduler process pauses a server
        const claimed = await servers.findOneAndUpdate(
            { _id: candidate._id, pausedAt: null },
            { $set: { pausedAt: now, status: 'unknown', error: null, responseTime: null, slowAlerted: false, nextCheckAt: NEVER } },
            { new: true }
        ).lean();
        if (!claimed) continue;

        paused += 1;
        try {
            await incidents.updateOne({ serverId: claimed._id, open: true }, { $set: { open: false, endedAt: now } });
            await onPaused(claimed);
        } catch (err) {
            logger.error(`Paused ${claimed.name || claimed._id} but could not finish tidying up: ${err.message}`);
        }
    }

    // Tell each owner once, one email for all of their paused servers
    const unnotified = await servers.find({
        pausedAt: { $gte: new Date(now.getTime() - NOTICE_RETRY_MS) },
        trialNoticeSentAt: null,
        'monitoring.trialEndsAt': { $ne: null }
    }).select('_id uploadedBy name url').limit(BATCH).lean();

    const byOwner = new Map();
    for (const server of unnotified) {
        const key = String(server.uploadedBy);
        byOwner.set(key, [...(byOwner.get(key) || []), server]);
    }

    let notified = 0;
    for (const [ownerId, owned] of byOwner) {
        try {
            const user = await users.findById(ownerId).select('email displayName').lean();
            // An owner that no longer exists, or has no address, cannot be told: stop trying
            const sent = user?.email ? await sendNotice(user, owned) : true;
            if (sent) {
                await servers.updateMany({ _id: { $in: owned.map((s) => s._id) } }, { $set: { trialNoticeSentAt: now } });
                notified += 1;
            }
        } catch (err) {
            logger.error(`Could not send the trial-ended notice for user ${ownerId}; it will be retried: ${err.message}`);
        }
    }

    if (paused > 0 || notified > 0) logger.info(`Trial pause: ${paused} servers paused, ${notified} owners notified`);
    return { paused, notified };
}

export default { pauseExpiredTrials, expiredTrialFilter, NEVER, NOTICE_RETRY_MS };
