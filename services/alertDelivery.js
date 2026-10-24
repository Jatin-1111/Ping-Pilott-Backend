// services/alertDelivery.js - deliver one pending alert, remembering what has already gone out
//
// Each part (feed row, email, webhook) is tracked on its own. When one fails the job throws so the queue retries,
// and the retry repeats only what is still missing: a flaky webhook never sends the email twice, and an email outage
// never holds back the in-app alert.
//
// The collaborators are passed in (`deps`) so this runs in tests without a database, Redis or SMTP.

import logger from '../utils/logger.js';

const MAX_ERROR_LENGTH = 300;
const clip = (text) => String(text).slice(0, MAX_ERROR_LENGTH);

/**
 * @param {Object} pending  the PendingAlert row (lean): _id, serverId, alertType, oldStatus, checkResult, done
 * @param {Object} deps
 * @param {(serverId) => Promise<Object|null>} deps.findServer         the server as it is now
 * @param {(pendingId, set) => Promise<void>} deps.saveProgress        $set on the pending row (no-op without an id)
 * @param {(pending, server) => Promise<void>} deps.recordFeed         write the feed row and push it live; throws if it could not be written
 * @param {(server, type, result, done) => Promise<{email, webhook, errors}>} deps.sendChannels
 * @returns {Promise<{ status: 'delivered' | 'dropped' }>}  throws when something is still undelivered
 */
export async function deliverAlert(pending, deps) {
    const server = await deps.findServer(pending.serverId);
    if (!server) {
        await deps.saveProgress(pending._id, { deliveredAt: new Date(), lastError: 'the server no longer exists' });
        logger.info(`Alert ${pending._id} dropped: server ${pending.serverId} no longer exists`);
        return { status: 'dropped' };
    }

    const done = { recorded: Boolean(pending.done?.recorded), email: Boolean(pending.done?.email), webhook: Boolean(pending.done?.webhook) };
    // The server as it was when the alert was raised: the status it moved away from is what the message describes
    const alertServer = { ...server, _id: pending.serverId, status: pending.oldStatus };
    const errors = [];

    if (!done.recorded) {
        try {
            await deps.recordFeed(pending, alertServer);
            done.recorded = true;
        } catch (err) {
            errors.push(err);
        }
    }

    const sent = await deps.sendChannels(alertServer, pending.alertType, pending.checkResult || {}, done);
    done.email = sent.email;
    done.webhook = sent.webhook;
    errors.push(...sent.errors);

    const finished = done.recorded && done.email && done.webhook;
    const set = {
        'done.recorded': done.recorded,
        'done.email': done.email,
        'done.webhook': done.webhook,
        lastError: finished ? null : clip(errors[0]?.message || 'not delivered')
    };
    if (finished) set.deliveredAt = new Date();
    await deps.saveProgress(pending._id, set);

    if (!finished) {
        throw new Error(`Alert ${pending._id} for server ${pending.serverId} is not fully delivered (feed ${done.recorded ? 'ok' : 'pending'}, email ${done.email ? 'ok' : 'pending'}, webhook ${done.webhook ? 'ok' : 'pending'}): ${clip(errors[0]?.message || 'unknown error')}`);
    }
    return { status: 'delivered' };
}

export default { deliverAlert };
