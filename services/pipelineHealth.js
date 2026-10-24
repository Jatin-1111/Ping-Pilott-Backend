// services/pipelineHealth.js - is monitoring actually happening?
//
// /health used to ask only "are Mongo, Redis and the scheduler up". The scheduler putting jobs on a queue says nothing
// about whether anything takes them off, so a dead worker left every light green while no server was checked.
// This answers the real question: workers alive, and a check completed since one was queued.

import { readWorkerState } from '../utils/workerHealth.js';

/** Work was queued this long ago and no check has finished since: the workers are not doing their job */
export const NO_COMPLETION_MS = 5 * 60 * 1000;
/** After a restart, workers and the first checks need a moment before their absence means anything */
export const STARTUP_GRACE_MS = 2 * 60 * 1000;
const DISPATCH_MEMORY_MS = 30 * 60 * 1000;

// When this process's scheduler last queued checks (the ones it queued in the last half hour)
let dispatches = [];

export const recordDispatch = (now = Date.now()) => {
    dispatches.push(now);
    dispatches = dispatches.filter((at) => now - at <= DISPATCH_MEMORY_MS);
};

export const recentDispatches = (now = Date.now()) => dispatches.filter((at) => now - at <= DISPATCH_MEMORY_MS);

/** For tests */
export const resetDispatches = () => { dispatches = []; };

/**
 * Pure rule. Returns the state and every reason found, so the log and the caller can say what is wrong.
 *   ok        monitoring is running
 *   starting  something is missing but the process only just started
 *   degraded  something is wrong
 * Reasons: scheduler-stalled, egress-down, no-monitor-worker, no-alert-worker, checks-not-completing, cannot-read-state
 * @param {Object} p
 * @param {number} p.now
 * @param {number} p.startedAt                 when this process started
 * @param {'ok'|'stalled'|'starting'} p.schedulerStatus
 * @param {number|null} p.monitorWorkers       how many monitor workers have a live heartbeat (null: unknown)
 * @param {number|null} p.alertWorkers
 * @param {number|null} p.lastCheckCompletedAt epoch ms of the last finished check, or null
 * @param {number[]} p.dispatches              epoch ms of recent cycles that queued checks
 */
export function evaluatePipeline({ now = Date.now(), startedAt = 0, schedulerStatus, monitorWorkers, alertWorkers, lastCheckCompletedAt, egressDown = false, dispatches: queued = [] }) {
    const reasons = [];

    if (schedulerStatus === 'stalled') reasons.push('scheduler-stalled');
    // A worker could not reach the control targets lately: its checks are being skipped, not recorded (egressProbe.js)
    if (egressDown) reasons.push('egress-down');

    if (monitorWorkers === null || monitorWorkers === undefined) {
        reasons.push('cannot-read-state');
    } else {
        if (monitorWorkers === 0) reasons.push('no-monitor-worker');
        if (alertWorkers === 0) reasons.push('no-alert-worker');

        // The oldest check queued since the last one finished. If that was queued long ago, nothing is taking jobs.
        // (Checks queued once an hour are fine: they finish within seconds, so the next completion is newer than the
        // dispatch and this stays empty.)
        const waitingSince = queued.filter((at) => lastCheckCompletedAt == null || at > lastCheckCompletedAt).sort((a, b) => a - b)[0];
        if (waitingSince !== undefined && now - waitingSince > NO_COMPLETION_MS) reasons.push('checks-not-completing');
    }

    if (reasons.length === 0) return { state: 'ok', reasons };
    if (now - startedAt < STARTUP_GRACE_MS && !reasons.includes('scheduler-stalled')) return { state: 'starting', reasons };
    return { state: 'degraded', reasons };
}

const CACHE_MS = 5000;
let cached = null;

/**
 * The live answer for this process. Reads Redis, so it is cached for a few seconds: /health is public and polled.
 * @param {{ redis, schedulerStatus: string, startedAt: number, now?: number }} p
 */
export async function getPipelineHealth({ redis, schedulerStatus, startedAt, now = Date.now() }) {
    if (cached && now - cached.at < CACHE_MS) return cached.value;

    let state = { monitorWorkers: null, alertWorkers: null, lastCheckCompletedAt: null, egressDown: false };
    try {
        state = await readWorkerState(redis);
    } catch {
        // evaluatePipeline reports it as cannot-read-state
    }

    const value = evaluatePipeline({ now, startedAt, schedulerStatus, ...state, dispatches: recentDispatches(now) });
    cached = { at: now, value };
    return value;
}

/** For tests */
export const resetPipelineCache = () => { cached = null; };

export default { evaluatePipeline, getPipelineHealth, recordDispatch, recentDispatches };
