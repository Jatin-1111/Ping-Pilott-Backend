// utils/logThrottle.js - say a repeating problem once per interval, with a count of what was held back
//
// A lost Redis connection raises an error on every reconnect attempt (every 2 seconds at most): 2,440 identical
// lines in one local log, enough to rotate the useful lines out of the 5 MB files.

const state = new Map();

/**
 * Run `log` at most once per `intervalMs` for the same `key`.
 * @param {string} key
 * @param {number} intervalMs
 * @param {(suppressed: number) => void} log  receives how many calls were skipped since it last ran
 * @param {number} [now]
 * @returns {boolean} true when `log` ran
 */
export function throttled(key, intervalMs, log, now = Date.now()) {
    const entry = state.get(key) || { at: -Infinity, suppressed: 0 };

    if (now - entry.at < intervalMs) {
        entry.suppressed += 1;
        state.set(key, entry);
        return false;
    }

    const suppressed = entry.suppressed;
    state.set(key, { at: now, suppressed: 0 });
    log(suppressed);
    return true;
}

/** " (12 more in the last 30s)" or "" */
export const suppressedNote = (count, intervalMs) => (count > 0 ? ` (${count} more in the last ${Math.round(intervalMs / 1000)}s)` : '');

export default { throttled, suppressedNote };
