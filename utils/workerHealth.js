// utils/workerHealth.js - workers say they are alive, and the API reads whether they are
//
// The scheduler only puts jobs on a queue. Nothing used to show whether anything took them off again, so a dead worker
// left /health green while no server was being checked. Each worker now writes a short-lived heartbeat key, and the
// monitor worker also records when it last finished a check.

import logger from './logger.js';
import { withTimeout } from './timeout.js';
import { throttled } from './logThrottle.js';
import { LAST_CHECK_KEY, beatKey, beatPattern } from './healthKeys.js';

export const BEAT_INTERVAL_MS = 15 * 1000;
export const BEAT_TTL_SECONDS = 60;
const REDIS_TIMEOUT_MS = 3000;

/**
 * Write a heartbeat every few seconds while the worker is running. Redis being down only costs a warning:
 * a worker that cannot reach Redis cannot take jobs either, and its key expires, which is the signal.
 * @param {{ redis, role: 'monitor'|'alert', isRunning?: () => boolean }} p
 * @returns {{ key: string, beat: () => Promise<void>, stop: () => Promise<void> }}
 */
export function startWorkerHeartbeat({ redis, role, isRunning = () => true, intervalMs = BEAT_INTERVAL_MS, ttlSeconds = BEAT_TTL_SECONDS, id }) {
    const key = beatKey(role, id);

    const beat = async () => {
        if (!isRunning()) return;
        try {
            await withTimeout(redis.set(key, String(Date.now()), 'EX', ttlSeconds), REDIS_TIMEOUT_MS, `${role} worker heartbeat`);
        } catch (err) {
            throttled(`heartbeat-${role}`, 60 * 1000, () => logger.warn(`Could not write the ${role} worker heartbeat: ${err.message}`));
        }
    };

    beat();
    const timer = setInterval(beat, intervalMs);
    timer.unref?.();

    return {
        key,
        beat,
        // On a clean shutdown remove the key at once instead of letting it expire
        stop: async () => {
            clearInterval(timer);
            try {
                await withTimeout(redis.del(key), 2000, `${role} worker heartbeat removal`);
            } catch {
                // it expires on its own
            }
        },
    };
}

/**
 * Returns a function to call after every finished check. It writes the time to Redis at most once per `minGapMs`
 * (a busy worker finishes many checks a second) and never throws.
 */
export function createCheckCompletionRecorder({ redis, minGapMs = 5000, now = Date.now }) {
    let last = -Infinity;
    return () => {
        const at = now();
        if (at - last < minGapMs) return;
        last = at;
        withTimeout(redis.set(LAST_CHECK_KEY, String(at)), REDIS_TIMEOUT_MS, 'check completion marker').catch(() => {});
    };
}

const countKeys = async (redis, pattern) => {
    let cursor = '0';
    let count = 0;
    do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = next;
        count += keys.length;
    } while (cursor !== '0');
    return count;
};

/**
 * What the workers have reported. Throws when Redis cannot be read in time.
 * @returns {Promise<{ monitorWorkers: number, alertWorkers: number, lastCheckCompletedAt: number|null }>}
 */
export async function readWorkerState(redis, timeoutMs = REDIS_TIMEOUT_MS) {
    return withTimeout((async () => {
        const [monitorWorkers, alertWorkers, last] = await Promise.all([
            countKeys(redis, beatPattern('monitor')),
            countKeys(redis, beatPattern('alert')),
            redis.get(LAST_CHECK_KEY),
        ]);
        const parsed = last === null || last === undefined ? NaN : Number(last);
        return { monitorWorkers, alertWorkers, lastCheckCompletedAt: Number.isFinite(parsed) ? parsed : null };
    })(), timeoutMs, 'Reading worker state');
}

export default { startWorkerHeartbeat, createCheckCompletionRecorder, readWorkerState, BEAT_INTERVAL_MS, BEAT_TTL_SECONDS };
