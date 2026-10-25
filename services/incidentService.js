// services/incidentService.js - opens and closes incidents as servers go down and recover

import Incident from '../models/Incident.js';
import Server from '../models/Server.js';
import logger from '../utils/logger.js';
import { cleanTimings } from '../utils/timings.js';
import { FAILED_PHASES } from '../utils/failurePhase.js';
import { cleanEvidence } from '../utils/evidence.js';

const MAX_ERROR_LENGTH = 300;

/** Check errors can be long (whole response bodies, stack traces). Keep enough to say what went wrong. */
export const trimError = (error) => (error ? String(error).slice(0, MAX_ERROR_LENGTH) : null);

/**
 * What the first failing check found, in the form an incident keeps it. Only what is usable is returned, so an incident
 * without detail is saved exactly as it was before the detail existed.
 * @param {{ failedPhase?: string, statusCode?: number, timings?: Object, evidence?: Object }} found
 * @returns {{ failedPhase?: string, statusCode?: number, timings?: Object, evidence?: Object }}
 */
export const failureFields = (found = {}) => {
    const fields = {};
    if (FAILED_PHASES.includes(found.failedPhase)) fields.failedPhase = found.failedPhase;
    if (Number.isInteger(found.statusCode)) fields.statusCode = found.statusCode;
    const timings = cleanTimings(found.timings);
    if (timings) fields.timings = timings;
    const evidence = cleanEvidence(found.evidence);
    if (evidence) fields.evidence = evidence;
    return fields;
};

/**
 * What a status change means for incidents.
 * Only going down opens one. Any move away from down (up, or unknown when checking stops) ends it.
 * @returns {'open' | 'close' | null}
 */
export const incidentAction = (previous, next) => {
    if (previous === next) return null;
    if (next === 'down') return 'open';
    if (previous === 'down') return 'close';
    return null;
};

/**
 * Record a status change. Never throws: a problem here must not stop a check from being saved or an alert
 * from going out. `model` is a parameter so the behaviour can be tested without a database.
 */
export async function recordStatusChange(server, previous, checkResult, now = new Date(), model = Incident) {
    const action = incidentAction(previous, checkResult.status);
    if (!action) return;

    try {
        if (action === 'open') {
            await model.create({
                serverId: server._id,
                userId: server.uploadedBy,
                startedAt: now,
                error: trimError(checkResult.error),
                failureKind: checkResult.failure?.kind ?? null,
                ...failureFields(checkResult),
                open: true
            });
        } else {
            await model.updateOne({ serverId: server._id, open: true }, { $set: { endedAt: now, open: false } });
        }
    } catch (err) {
        // Two checks raced and the other one already opened it: exactly one is what we want
        if (err && err.code === 11000) return;
        logger.error(`Could not record incident change for ${server.name || server._id}: ${err.message}`);
    }
}

/**
 * Bring incidents in line with the servers' current status. Run once at start-up so the list matches
 * reality for servers that were already down when incidents were introduced, and for any change that was
 * missed while the process was not running. Safe to run any number of times.
 * @returns {{ opened: number, closed: number }}
 */
export async function reconcileOpenIncidents() {
    try {
        const down = await Server.find({ status: 'down' }).select('_id uploadedBy lastStatusChange error failureKind failedPhase failureStatusCode failureTimings failureEvidence').lean();
        const downIds = down.map((s) => s._id);

        const open = downIds.length
            ? await Incident.find({ open: true, serverId: { $in: downIds } }).select('serverId').lean()
            : [];
        const alreadyOpen = new Set(open.map((i) => String(i.serverId)));

        let opened = 0;
        for (const server of down) {
            if (alreadyOpen.has(String(server._id))) continue;
            try {
                await Incident.create({
                    serverId: server._id,
                    userId: server.uploadedBy,
                    startedAt: server.lastStatusChange || new Date(),
                    error: trimError(server.error),
                    failureKind: server.failureKind ?? null,
                    ...failureFields({ failedPhase: server.failedPhase, statusCode: server.failureStatusCode, timings: server.failureTimings, evidence: server.failureEvidence }),
                    open: true
                });
                opened += 1;
            } catch (err) {
                if (!(err && err.code === 11000)) throw err;
            }
        }

        // Ongoing incidents whose server is no longer down (it recovered while nothing was recording)
        const closedResult = await Incident.updateMany(
            { open: true, serverId: { $nin: downIds } },
            { $set: { open: false, endedAt: new Date() } }
        );
        const closed = closedResult.modifiedCount || 0;

        if (opened || closed) logger.info(`Incidents reconciled: ${opened} opened, ${closed} closed`);
        return { opened, closed };
    } catch (err) {
        logger.error(`Could not reconcile incidents: ${err.message}`);
        return { opened: 0, closed: 0 };
    }
}

export default { trimError, failureFields, incidentAction, recordStatusChange, reconcileOpenIncidents };
