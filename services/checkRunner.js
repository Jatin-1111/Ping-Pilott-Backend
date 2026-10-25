// services/checkRunner.js - the one way a server is checked, whoever asked
//
// The scheduled worker confirmed a first failure before acting on it; the "Check now" button and the batch check did
// not, so one dropped packet during a manual check flipped the server to down and sent a DOWN email at once. All
// three now go through here.
//
// A failure is also only believed while this machine can reach the internet (services/egressProbe.js). Otherwise the
// check throws EgressDownError and nothing is recorded: our outage must not look like every customer's outage.
//
// And a slow result is marked `loadSuspect` when this process's own event loop was stalled while it was measured
// (services/loadMonitor.js): the time then says more about us than about the server.

import { performance } from 'perf_hooks';
import { checkServerStatus } from './monitoringService.js';
import { egressProbe, EgressDownError } from './egressProbe.js';
import { loadMonitor, loopLagLimitMs } from './loadMonitor.js';

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
 * more after a short wait, and the second answer is the result, so one dropped request does not page anyone. The same
 * goes the other way: a server that was down and answers is checked once more before it counts as recovered.
 * @param {Object} server  needs the fields checkServerStatus reads, plus `status`
 * @param {Object} [options]  replaceable in tests
 * @returns {Promise<{ status, responseTime, error, slow, timings, loadSuspect? }>}
 * @throws {EgressDownError} when a check failed and the control targets cannot be reached either
 */
export async function runCheck(server, {
    check = checkServerStatus,
    sleep = sleepFor,
    delayMs = confirmDelayMs(),
    isEgressUp = (maxAgeMs) => egressProbe.isUp(maxAgeMs),
    clock = () => performance.now(),
    lagSince = (since) => loadMonitor.lagSince(since),
    lagLimitMs = loopLagLimitMs()
} = {}) {
    // One check, marked if it was slow while this process was stalled. Only a slow result can have been made worse by
    // that: a fast one was not, and a failure is confirmed by the second attempt and the egress probe instead.
    const measure = async () => {
        const startedAt = clock();
        const result = await check(server);
        if (lagLimitMs > 0 && result.status === 'up' && result.slow && lagSince(startedAt) >= lagLimitMs) {
            return { ...result, loadSuspect: true };
        }
        return result;
    };

    const result = await measure();

    // A server that was down answering once is not yet "recovered": a flaky one answers now and then. Check again after
    // the same wait, and believe the second answer, so one lucky request does not send a RECOVERED email that the next
    // failure turns into a DOWN email.
    if (result.status === 'up' && server.status === 'down' && delayMs > 0) {
        await sleep(delayMs);
        const second = await measure();
        // The network may have gone during the wait: then a failure says nothing about the server
        if (second.status === 'down' && !(await isEgressUp(5000))) throw new EgressDownError();
        return second;
    }

    if (result.status !== 'down') return result;

    // Is it them, or is it us? Asked before the confirmation wait so a dead network does not hold a worker slot for it
    if (!(await isEgressUp(15000))) throw new EgressDownError();

    if (server.status !== 'down' && delayMs > 0) {
        await sleep(delayMs);
        const second = await measure();
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
