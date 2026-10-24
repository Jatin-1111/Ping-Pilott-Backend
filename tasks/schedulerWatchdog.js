// tasks/schedulerWatchdog.js - notices when the check scheduler has gone quiet, and unblocks it
//
// The per-run timeout in utils/jobQueue.js is the main protection. This is the second line: it looks at the result
// (has a cycle finished successfully recently?) rather than at one run, so it also catches a scheduler that stopped
// for any other reason, says so loudly in the logs, and exposes the state for /health.

import logger from '../utils/logger.js';

export const SCHEDULER_JOB = 'smartCheckServers';

// Cycles run every 1 to 3 minutes, so this much silence means something is wrong
export const MAX_SILENCE_MS = 10 * 60 * 1000;
export const WATCHDOG_INTERVAL_MS = 2 * 60 * 1000;

/**
 * @param {Object} p
 * @param {Date|number|null} p.lastRun   when a cycle last finished successfully
 * @param {number} p.startedAt           when the scheduler started: the grace period before the first cycle
 * @returns {'ok'|'stalled'}
 */
export function evaluateScheduler({ lastRun, startedAt, now = Date.now(), maxSilenceMs = MAX_SILENCE_MS }) {
    const reference = lastRun ? new Date(lastRun).getTime() : startedAt;
    return now - reference > maxSilenceMs ? 'stalled' : 'ok';
}

/**
 * Check periodically; when stalled, log it and release a lock that is holding the scheduler.
 * @param {Object} p
 * @param {import('../utils/jobQueue.js').JobQueue} p.queue
 */
export function startSchedulerWatchdog({
    queue,
    jobName = SCHEDULER_JOB,
    intervalMs = WATCHDOG_INTERVAL_MS,
    maxSilenceMs = MAX_SILENCE_MS,
    startedAt = Date.now(),
}) {
    const status = (now = Date.now()) =>
        evaluateScheduler({ lastRun: queue.lastRunOf(jobName), startedAt, now, maxSilenceMs });

    const check = (now = Date.now()) => {
        const state = status(now);
        if (state === 'stalled') {
            const last = queue.lastRunOf(jobName);
            logger.error(
                `🚨 SCHEDULER STALLED: no check cycle has finished ${last ? `since ${new Date(last).toISOString()}` : 'since startup'}. ` +
                'Servers are not being checked.'
            );
            if (queue.forceRelease(jobName)) {
                logger.error(`🚨 Released the stuck '${jobName}' lock; the next cycle will start normally.`);
            }
        }
        return state;
    };

    const timer = setInterval(check, intervalMs);
    // Never keep the process alive just for this
    timer.unref?.();

    return { status, check, stop: () => clearInterval(timer) };
}

export default { evaluateScheduler, startSchedulerWatchdog, SCHEDULER_JOB, MAX_SILENCE_MS, WATCHDOG_INTERVAL_MS };
