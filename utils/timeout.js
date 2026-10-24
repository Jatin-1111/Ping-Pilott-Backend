// utils/timeout.js - give up on something that may never answer
//
// Redis commands queue forever while the connection is down (BullMQ needs maxRetriesPerRequest: null), so an
// awaited queue call during a Redis hiccup can hang with no error. Anything the scheduler waits on goes through here.

export class TimeoutError extends Error {
    constructor(label, ms) {
        super(`${label} timed out after ${ms}ms`);
        this.name = 'TimeoutError';
        this.label = label;
        this.ms = ms;
    }
}

/**
 * Resolve or reject with `promise`, unless it takes longer than `ms`, then reject with a TimeoutError.
 * The original promise is not cancelled (JavaScript can't), but if it fails later nothing is left unhandled.
 */
export function withTimeout(promise, ms, label = 'operation') {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export default { withTimeout, TimeoutError };
