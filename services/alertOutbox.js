// services/alertOutbox.js - keep every alert until it is delivered
//
// enqueueAlert    writes the PendingAlert row when a check changes a server's status, then queues a job for it.
//                 If the row is saved but the queue is unreachable, the row is what lets the alert be found later.
// requeueUndelivered  runs on a timer: queues alerts that never got a job or whose job ran out of attempts, and gives
//                 up (loudly) on alerts older than 24 hours.
//
// Both take the model and the queue as parameters, so the behaviour can be tested without a database or Redis.

import logger from '../utils/logger.js';
import { shouldSendAlert } from './alertService.js';

/** A job has had this long to finish all its attempts (about 7 minutes at most), so a later one is safe to add */
export const REQUEUE_AFTER_MS = 15 * 60 * 1000;
/** An alert that was never queued is picked up after this long */
export const NEVER_QUEUED_GRACE_MS = 60 * 1000;
export const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;

const BATCH = 100;

const pick = (checkResult = {}) => ({
    status: checkResult.status,
    responseTime: checkResult.responseTime ?? null,
    error: checkResult.error ?? null,
    slow: Boolean(checkResult.slow)
});

/** Add a job for one pending alert. Never throws: a queue that is down is the case this exists for. */
const queueJob = async (doc, queue, model, jobId) => {
    try {
        await queue.add({ pendingId: String(doc._id), serverId: String(doc.serverId) }, doc.priority, jobId);
        await model.updateOne({ _id: doc._id }, { $set: { lastQueuedAt: new Date() } });
        return true;
    } catch (err) {
        logger.error(`Could not queue alert ${doc._id} (${doc.alertType}) for server ${doc.serverId}; it stays pending and will be retried:`, err);
        return false;
    }
};

/**
 * Record that this server's owner has to be told, and queue the job that tells them.
 * Nothing is recorded when the owner's own settings say not to alert right now (alerts off, outside their alert hours).
 * Never throws, so a problem here cannot stop a check from being saved.
 * @returns the pending row, or null when there is nothing to send or it could not be saved
 */
export async function enqueueAlert({ server, alertType, previous, checkResult }, { model, queue, shouldSend = shouldSendAlert }) {
    try {
        if (!shouldSend(server)) return null;

        const doc = await model.create({
            serverId: server._id,
            userId: server.uploadedBy,
            alertType,
            oldStatus: previous,
            newStatus: checkResult.status,
            priority: server.priority === 'high' ? 'high' : 'normal',
            checkResult: pick(checkResult)
        });

        await queueJob(doc, queue, model, `alert-${doc._id}`);
        return doc;
    } catch (err) {
        logger.error(`Could not record the ${alertType} alert for ${server.name || server._id}; the owner will not be told:`, err);
        return null;
    }
}

/**
 * Queue alerts that have no live job, and give up on the ones that are too old.
 * @returns {{ requeued: number, abandoned: number }}
 */
export async function requeueUndelivered({ model, queue, now = new Date() }) {
    const giveUpBefore = new Date(now.getTime() - GIVE_UP_AFTER_MS);

    // Too old: say so once, with enough to find it, and stop
    const tooOld = await model.find({ deliveredAt: null, abandonedAt: null, createdAt: { $lt: giveUpBefore } })
        .select('serverId alertType lastError createdAt').limit(BATCH).lean();
    if (tooOld.length > 0) {
        for (const alert of tooOld) {
            logger.error(`Gave up on the ${alert.alertType} alert ${alert._id} for server ${alert.serverId} after 24 hours; the owner was not fully notified. Last error: ${alert.lastError || 'none'}`);
        }
        await model.updateMany({ _id: { $in: tooOld.map((a) => a._id) } }, { $set: { abandonedAt: now } });
    }

    const staleBefore = new Date(now.getTime() - REQUEUE_AFTER_MS);
    const neverQueuedBefore = new Date(now.getTime() - NEVER_QUEUED_GRACE_MS);
    const candidates = await model.find({
        deliveredAt: null,
        abandonedAt: null,
        createdAt: { $gte: giveUpBefore },
        $or: [
            { lastQueuedAt: null, createdAt: { $lt: neverQueuedBefore } },
            { lastQueuedAt: { $lt: staleBefore } }
        ]
    }).limit(BATCH).lean();

    let requeued = 0;
    for (const candidate of candidates) {
        // Claim it: only one scheduler process wins, and a row another process just queued is left alone
        const claimed = await model.findOneAndUpdate(
            { _id: candidate._id, deliveredAt: null, abandonedAt: null, lastQueuedAt: candidate.lastQueuedAt ?? null },
            { $set: { lastQueuedAt: now }, $inc: { requeues: 1 } },
            { new: true }
        ).lean();
        if (!claimed) continue;

        try {
            await queue.add({ pendingId: String(claimed._id), serverId: String(claimed.serverId) }, claimed.priority, `alert-${claimed._id}-${claimed.requeues}`);
            requeued += 1;
        } catch (err) {
            // Put the claim back so the next run tries again
            logger.error(`Could not re-queue alert ${claimed._id} for server ${claimed.serverId}:`, err);
            await model.updateOne({ _id: claimed._id }, { $set: { lastQueuedAt: candidate.lastQueuedAt ?? null } }).catch(() => {});
        }
    }

    if (requeued > 0 || tooOld.length > 0) logger.info(`Alert reconciler: ${requeued} re-queued, ${tooOld.length} abandoned`);
    return { requeued, abandoned: tooOld.length };
}

export default { enqueueAlert, requeueUndelivered, REQUEUE_AFTER_MS, NEVER_QUEUED_GRACE_MS, GIVE_UP_AFTER_MS };
