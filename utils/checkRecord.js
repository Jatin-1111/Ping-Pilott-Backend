// utils/checkRecord.js - the optional fields a check's history row carries beyond status, time and error
//
// One place decides them, so the scheduled worker and the manual and batch checks write the same row.
// A field that does not apply is left out entirely (rather than stored as null) to keep the time-series rows small.

import { cleanTimings } from './timings.js';

/**
 * @param {Object} checkResult  { timings, serverTime, loadSuspect, failure: { kind }, statusCode }
 * @returns {Object} any of: timings, serverTime, loadSuspect, failureKind, statusCode
 */
export const checkExtras = (checkResult = {}) => {
    const extras = {};

    const timings = cleanTimings(checkResult.timings);
    if (timings) extras.timings = timings;

    if (Number.isFinite(checkResult.serverTime) && checkResult.serverTime >= 0) extras.serverTime = Math.round(checkResult.serverTime);

    if (checkResult.loadSuspect === true) extras.loadSuspect = true;
    if (checkResult.failure?.kind) extras.failureKind = checkResult.failure.kind;
    if (Number.isInteger(checkResult.statusCode)) extras.statusCode = checkResult.statusCode;

    return extras;
};

export default { checkExtras };
