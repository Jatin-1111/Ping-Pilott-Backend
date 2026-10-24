// services/retentionFix.js - give an existing serverchecks collection the TTL its model now declares
//
// A time-series collection keeps its time-to-live as a collection option, not as an index. A collection created before
// the model said so has none, and Mongoose never changes an existing collection. MongoDB's collMod command can set it
// in place: no data is touched and nothing is rebuilt; documents older than the limit are then removed by MongoDB
// itself, in the background.
//
// Only runs when told to (scripts/setRetentionTtl.js --apply). `planTtlChange` decides, `applyTtlChange` does it.

import { MAX_RETENTION_DAYS } from '../utils/retention.js';

export const TARGET_TTL_SECONDS = MAX_RETENTION_DAYS * 24 * 60 * 60;
const COLLECTION = 'serverchecks';

/**
 * @param {Object} p
 * @param {Object|undefined} p.info  the collection's entry from listCollections (undefined when it does not exist)
 * @returns {{ action: 'none'|'set'|'cannot', reason: string, current: number|null, target: number }}
 */
export function planTtlChange({ info, target = TARGET_TTL_SECONDS }) {
    if (!info) {
        return { action: 'none', reason: 'The serverchecks collection does not exist yet. It is created with the TTL when the app first saves a check.', current: null, target };
    }
    if (!info.options?.timeseries) {
        return { action: 'cannot', reason: 'serverchecks is not a time-series collection, so this option does not apply to it. Nothing was changed.', current: null, target };
    }
    const current = info.options.expireAfterSeconds ?? null;
    if (current === target) {
        return { action: 'none', reason: `The TTL is already ${target} seconds (${target / 86400} days).`, current, target };
    }
    return {
        action: 'set',
        reason: current === null ? `No TTL is set. It would be set to ${target} seconds (${target / 86400} days).` : `The TTL is ${current} seconds. It would be changed to ${target} seconds (${target / 86400} days).`,
        current,
        target
    };
}

/** Run collMod. The one write in this file. */
export async function applyTtlChange({ db, target = TARGET_TTL_SECONDS }) {
    return db.command({ collMod: COLLECTION, expireAfterSeconds: target });
}

export default { planTtlChange, applyTtlChange, TARGET_TTL_SECONDS };
