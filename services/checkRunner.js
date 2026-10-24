// services/checkRunner.js - the one way a server is checked, whoever asked
//
// The scheduled worker confirmed a first failure before acting on it; the "Check now" button and the batch check did
// not, so one dropped packet during a manual check flipped the server to down and sent a DOWN email at once. All
// three now go through here.
//
// A failure is also only believed while this machine can reach the internet (services/egressProbe.js). Otherwise the
// check throws EgressDownError and nothing is recorded: our outage must not look like every customer's outage.

import { checkServerStatus } from './monitoringService.js';
import { egressProbe, EgressDownError } from './egressProbe.js';

const DEFAULT_CONFIRM_DELAY_MS = 10000;

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a failure waits before it is re-checked. DOWN_CONFIRM_DELAY_MS=0 switches confirmation off. */
export const confirmDelayMs = (env = process.env) => {
    if (env.DOWN_CONFIRM_DELAY_MS === undefined) return DEFAULT_CONFIRM_DELAY_MS;
    const parsed = parseInt(env.DOWN_CONFIRM_DELAY_MS, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CONFIRM_DELAY_MS;
};

/**
 * Check a server. A failure on a server that is not already known to be down (up, or never checked) is checked once
 * more after a short wait, and the second answer is the result, so one dropped request does not page anyone.
 * @param {Object} server  needs the fields checkServerStatus reads, plus `status`
 * @param {Object} [options]  replaceable in tests
 * @returns {Promise<{ status, responseTime, error, slow }>}
 * @throws {EgressDownError} when a check failed and the control targets cannot be reached either
 */
export async function runCheck(server, { check = checkServerStatus, sleep = sleepFor, delayMs = confirmDelayMs(), isEgressUp = (maxAgeMs) => egressProbe.isUp(maxAgeMs) } = {}) {
    const result = await check(server);
    if (result.status !== 'down') return result;

    // Is it them, or is it us? Asked before the confirmation wait so a dead network does not hold a worker slot for it
    if (!(await isEgressUp(15000))) throw new EgressDownError();

    if (server.status !== 'down' && delayMs > 0) {
        await sleep(delayMs);
        const second = await check(server);
        // The network may have gone during the wait: ask again, with a fresher answer
        if (second.status === 'down' && !(await isEgressUp(5000))) throw new EgressDownError();
        return second;
    }
    return result;
}

/**
 * Query filter for uptime figures, which describe the monitor itself. Manual and batch checks happen when a
 * person asks, so counting them lets repeated clicks during an outage move the percentage. Rows written before
 * `checkType` existed have none and count as scheduled.
 */
export const SCHEDULED_CHECKS_ONLY = { checkType: { $nin: ['manual', 'batch'] } };

export default { runCheck, confirmDelayMs, SCHEDULED_CHECKS_ONLY };
