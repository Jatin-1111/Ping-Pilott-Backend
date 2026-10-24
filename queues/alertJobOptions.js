// queues/alertJobOptions.js - how hard one alert job tries before the reconciler takes over
//
// BullMQ's built-in 'exponential' backoff waits delay * 2^(attempt - 1): 15s, 30s, 60s, 120s. (The queue used to
// retry after 2s and 4s, so an email provider that was down for half a minute lost the alert. A custom
// `backoffStrategy` set on the worker was never used: BullMQ only calls it for a backoff type it does not know.)
// A job that still fails is left to services/alertOutbox.js, which re-queues undelivered alerts for 24 hours.

export const ALERT_ATTEMPTS = 5;
export const ALERT_BACKOFF_MS = 15 * 1000;

export const ALERT_JOB_OPTIONS = {
    attempts: ALERT_ATTEMPTS,
    backoff: { type: 'exponential', delay: ALERT_BACKOFF_MS },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400 }
};

/** Total time the waits between attempts add up to, in ms */
export const retryWindowMs = (attempts = ALERT_ATTEMPTS, delay = ALERT_BACKOFF_MS) => {
    let total = 0;
    for (let made = 1; made < attempts; made += 1) total += delay * 2 ** (made - 1);
    return total;
};

export default { ALERT_ATTEMPTS, ALERT_BACKOFF_MS, ALERT_JOB_OPTIONS, retryWindowMs };
