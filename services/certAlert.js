// services/certAlert.js - the part of recording a check that warns about a certificate close to expiry
//
// Kept apart from checkRecorder (which needs Redis and Mongo) and given its collaborators as parameters, so each case can be
// tested: the warning, the race, the owner who cannot be told right now, and a failure that must not stop a check.

import { planCertUpdate } from '../utils/certExpiry.js';
import logger from '../utils/logger.js';

/**
 * @param {Object} p
 * @param {Object} p.server       lean server doc: _id, name, status, certAlertedDays, monitoring
 * @param {Object} p.checkResult  { status, certExpiresAt }
 * @param {Date} p.now
 * @param {Object} deps
 * @param {(filter, update) => Promise<{ matchedCount: number }>} deps.updateOne
 * @param {(args) => Promise<any>} deps.enqueue      queue the alert (services/alertOutbox.js)
 * @param {(server) => boolean} deps.shouldSend      is the owner to be told right now (alerts on, inside their alert hours)
 * @returns {Promise<{ level: number, daysLeft: number, expiresAt: Date } | null>}  the warning raised, if any. Never throws.
 */
export async function raiseCertAlert({ server, checkResult, now = new Date() }, { updateOne, enqueue, shouldSend, log = logger }) {
    try {
        const plan = planCertUpdate({ server, checkResult, now });
        if (!plan) return null;

        // Not now (alerts are off, or it is outside the owner's alert hours): leave the level as it is, so a later check
        // tells them. Using it up here would mean they never hear about this step.
        if (plan.alert && !shouldSend(server)) return null;

        const written = await updateOne(plan.filter, { $set: plan.$set });
        if (written?.matchedCount !== 1) return null; // another check has already moved the level on

        if (!plan.alert) return null; // a renewed certificate: the level is reset, and there is nothing to say

        await enqueue({
            server,
            alertType: 'cert_expiring',
            previous: server.status,
            checkResult: { status: checkResult.status, cert: plan.alert }
        });
        return plan.alert;
    } catch (err) {
        log.error(`Could not handle the certificate of ${server?.name || server?._id}: ${err.message}`);
        return null;
    }
}

export default { raiseCertAlert };
