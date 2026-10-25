// utils/alertDecision.js - pure rules for what a finished check should tell the user, and what to save about it
//
// Down and recovery follow the status. A slow response is judged over several checks, not one: a single slow sample is
// usually the network, and a site that hovers around its threshold used to send an alert every time it crossed.

import { dampAlert, flapConfig } from './flapDamping.js';

/** Slow checks in a row, counting only scheduled checks, before a slow alert is raised. Fewer for slower schedules. */
export const slowChecksNeeded = (frequencyMinutes) => {
    const minutes = Number(frequencyMinutes) > 0 ? Number(frequencyMinutes) : 5;
    if (minutes <= 5) return 3;
    if (minutes <= 15) return 2;
    return 1; // a 30-minute monitor would wait an hour or more for a second sample
};

/** Checks in a row that are back under the threshold before an open slow alert is closed */
export const FAST_CHECKS_TO_CLOSE = 2;

const STREAK_CAP = 1000;
const count = (value) => (Number(value) > 0 ? Math.floor(Number(value)) : 0);

/**
 * Only the scheduled worker moves the slow counters. "Check now" and the batch check happen when a person asks, often
 * while looking at a problem, so they show their latency but never open or close a slow alert.
 */
export const countsTowardSlowStreak = (checkType = 'automated') => checkType === 'automated';

/**
 * What, if anything, to tell the user about this check, and the slow-streak state to save with it.
 *  up -> down        : "down"
 *  down -> up        : "recovery"
 *  unknown -> down   : "down"   (a server that has never been up still needs to be reported)
 *  unknown -> up     : nothing  (the first check is not a recovery)
 *  up and slow       : one "slow" alert once enough scheduled checks in a row were slow
 *  up and quick      : an open slow alert closes after FAST_CHECKS_TO_CLOSE quick checks in a row (no message)
 *  slow, but measured while our own event loop was stalled (`loadSuspect`): counts as neither slow nor quick. The time
 *                      says more about this process than about the server, so it is set aside.
 *
 * @param {string} previous  the server's status before this check
 * @param {Object} result    { status, slow, loadSuspect }
 * @param {Object} [state]   { slowAlerted, slowStreak, fastStreak } as saved on the server
 * @param {Object} [options] { frequency (minutes), checkType: 'automated' | 'manual' | 'batch' }
 * @returns {{ alertType: string|null, slowAlerted: boolean, slowStreak: number, fastStreak: number, touchStreak: boolean }}
 *   touchStreak is false when the saved counters must be left exactly as they are (a manual check that changed nothing).
 */
export const decideAlert = (previous, result, state = {}, { frequency, checkType = 'automated' } = {}) => {
    const scheduled = countsTowardSlowStreak(checkType);
    const setAside = result.slow === true && result.loadSuspect === true;
    let slowAlerted = state.slowAlerted === true;
    let slowStreak = count(state.slowStreak);
    let fastStreak = count(state.fastStreak);

    if (previous !== result.status) {
        let alertType = null;
        if (result.status === 'down') alertType = 'server_down';
        else if (result.status === 'up' && previous === 'down') alertType = 'server_recovery';

        // A new status starts a new streak. This check is the first sample of it when it is a scheduled "up".
        const firstSample = result.status === 'up' && scheduled && !setAside;
        return {
            alertType,
            slowAlerted: false,
            slowStreak: firstSample && result.slow ? 1 : 0,
            fastStreak: firstSample && !result.slow ? 1 : 0,
            touchStreak: true
        };
    }

    if (result.status !== 'up') {
        return { alertType: null, slowAlerted: false, slowStreak: 0, fastStreak: 0, touchStreak: true };
    }

    if (!scheduled || setAside) {
        return { alertType: null, slowAlerted, slowStreak, fastStreak, touchStreak: false };
    }

    let alertType = null;
    if (result.slow) {
        slowStreak = Math.min(slowStreak + 1, STREAK_CAP);
        fastStreak = 0;
        if (!slowAlerted && slowStreak >= slowChecksNeeded(frequency)) {
            alertType = 'slow_response';
            slowAlerted = true;
        }
    } else {
        slowStreak = 0;
        fastStreak = Math.min(fastStreak + 1, FAST_CHECKS_TO_CLOSE);
        if (slowAlerted && fastStreak >= FAST_CHECKS_TO_CLOSE) slowAlerted = false;
    }
    return { alertType, slowAlerted, slowStreak, fastStreak, touchStreak: true };
};

/**
 * What to write for a finished check. Kept apart from the database code so the rules can be tested alone.
 * @param {Object} p
 * @param {Object} p.server       lean server doc: _id, status, slowAlerted, slowStreak, fastStreak, alertedStatus,
 *                                statusChanges, flapHeldAt, monitoring
 * @param {Object} p.checkResult  { status, responseTime, error, slow }
 * @param {string} [p.checkType]  'automated' | 'manual' | 'batch'
 * @param {Date}   p.now
 * @param {Object} [p.flapSettings]  flapConfig(); replaceable in tests
 * @returns {{ filter: Object, $set: Object, alertType: string|null, changed: boolean, slowStreak: number, flap: Object|null }}
 *   `flap` is the note a down or recovery alert carries when it starts or ends a hold (utils/flapDamping.js).
 */
export const planCheckUpdate = ({ server, checkResult, checkType = 'automated', now, flapSettings = flapConfig() }) => {
    const previous = server.status;
    const changed = previous !== checkResult.status;
    const decision = decideAlert(previous, checkResult, server, { frequency: server.monitoring?.frequency, checkType });

    // A server that keeps going up and down is held: its down and recovery alerts stop (utils/flapDamping.js)
    const flap = dampAlert({ previous, status: checkResult.status, baseAlertType: decision.alertType, state: server, now, config: flapSettings });
    const alertType = flap.alertType;

    const $set = {
        status: checkResult.status,
        responseTime: checkResult.responseTime,
        serverTime: Number.isFinite(checkResult.serverTime) ? Math.round(checkResult.serverTime) : null,
        error: checkResult.error,
        failureKind: checkResult.failure?.kind ?? null,
        lastChecked: now
    };
    if (decision.touchStreak) {
        $set.slowAlerted = decision.slowAlerted;
        $set.slowStreak = decision.slowStreak;
        $set.fastStreak = decision.fastStreak;
    }
    if (changed) $set.lastStatusChange = now;
    // The certificate's expiry as last seen. Only when a check saw one: a failure or plain HTTP says nothing about it.
    if (checkResult.certExpiresAt instanceof Date && Number.isFinite(checkResult.certExpiresAt.getTime())) {
        $set.certExpiresAt = checkResult.certExpiresAt;
    }
    // Only written when it changes: the damping state is not touched by an ordinary check
    if (flap.touch) {
        $set.alertedStatus = flap.alertedStatus;
        $set.statusChanges = flap.statusChanges.map((t) => new Date(t));
        $set.flapHeldAt = flap.flapHeldAt === null ? null : new Date(flap.flapHeldAt);
    }

    // Compare-and-set: the write only applies if the server is still in the state this check was judged against
    const filter = { _id: server._id };
    if (changed) filter.status = previous;
    else if (alertType === 'slow_response') filter.slowAlerted = { $ne: true };
    // The check that ends a hold writes only if the server is still held, so two racing checks send one alert
    if (flap.release) filter.flapHeldAt = { $ne: null };

    return { filter, $set, alertType, changed, slowStreak: decision.slowStreak, flap: flap.flap };
};

export default { decideAlert, planCheckUpdate, slowChecksNeeded, countsTowardSlowStreak, FAST_CHECKS_TO_CLOSE };
