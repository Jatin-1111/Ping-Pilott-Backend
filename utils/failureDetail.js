// utils/failureDetail.js - a failure as an API response: the diagnosis, and where it stopped, with what the plan allows
//
// One place builds it for a server, a manual check and an incident, so they say the same thing in the same shape:
//   diagnosis      { title, cause, action }, plus causes and checks on a plan with the detail (utils/diagnosisDetail.js)
//   failureDetail  { failedPhase, timings, statusCode, evidence }, evidence only on a plan with the detail, and
//                  `locked: true` when there is detail this plan does not show, so the page can say so
// Every field is optional; a failure from before any of it was recorded gives the plain diagnosis and nothing else.
// Pure functions (no database).

import { diagnose } from './diagnosis.js';
import { diagnoseDetailed } from './diagnosisDetail.js';
import { cleanTimings } from './timings.js';
import { cleanEvidence } from './evidence.js';
import { FAILED_PHASES } from './failurePhase.js';

/**
 * @param {Object} p
 * @param {{ kind?: string|null, statusCode?: number|null, error?: string|null, failedPhase?: string|null,
 *           timings?: Object|null, evidence?: Object|null }} p.failure  as stored (utils/failures.js and the rest)
 * @param {{ url?: string, type?: string }} [p.server]  the monitor, for the commands
 * @param {boolean} p.detailed  whether the plan includes the detail (utils/planFeatures.js)
 * @returns {{ diagnosis: Object|null, failureDetail: Object|null }}
 */
export function failureView({ failure = {}, server = {}, detailed = false } = {}) {
    const phase = FAILED_PHASES.includes(failure.failedPhase) ? failure.failedPhase : null;
    const timings = cleanTimings(failure.timings);
    const evidence = cleanEvidence(failure.evidence);
    const statusCode = Number.isInteger(failure.statusCode) ? failure.statusCode : null;

    const diagnosis = detailed
        ? diagnoseDetailed({ kind: failure.kind, statusCode, error: failure.error, failedPhase: phase, timings, evidence, url: server.url, type: server.type })
        : diagnose({ kind: failure.kind, statusCode, error: failure.error });

    const failureDetail = {};
    if (phase) failureDetail.failedPhase = phase;
    if (timings) failureDetail.timings = timings;
    if (statusCode !== null) failureDetail.statusCode = statusCode;
    if (detailed && evidence) failureDetail.evidence = evidence;
    if (!detailed && (evidence || phase)) failureDetail.locked = true;

    return { diagnosis, failureDetail: Object.keys(failureDetail).length > 0 ? failureDetail : null };
}

export default { failureView };
