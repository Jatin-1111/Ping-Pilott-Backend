// utils/alertFeed.js - what an alert looks like to the mobile app, and how its feed is queried
//
// Pure functions (no database), so the message wording, the payload shape and the paging rules can be tested alone.

import { describeDominantPhase } from './timings.js';
import { describeFlap } from './flapDamping.js';
import { diagnose } from './diagnosis.js';
import { isHostAlert, hostAlertText } from './hostAlerts.js';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
export const ALERT_CHANNEL = 'alert-events';

// The alert types every version of the mobile app knows. An app shows a type it does not know as a notification with no
// title, so the feed only includes the newer (host) types for an app that asks for them: GET /api/alerts?include=host.
export const CLASSIC_TYPES = ['server_down', 'server_recovery', 'slow_response'];
export const HOST_TYPES = ['host_cpu_high', 'host_memory_high', 'host_disk_high', 'host_metrics_missing'];
export const feedTypes = (includeHost) => (includeHost ? [...CLASSIC_TYPES, ...HOST_TYPES] : CLASSIC_TYPES);

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const MAX_MESSAGE = 300;

const clip = (text) => String(text).slice(0, MAX_MESSAGE);

const ms = (value) => Math.round(Number(value));

/**
 * One line telling the user what happened, taken from the check that triggered the alert.
 * @param {string} type        'server_down' | 'server_recovery' | 'slow_response'
 * @param {Object} checkResult { status, responseTime, error }
 * @param {Object} server      the server document (for the user's slow-response threshold)
 */
export function buildAlertMessage(type, checkResult = {}, server = {}) {
    const responseTime = Number(checkResult.responseTime) > 0 ? ms(checkResult.responseTime) : null;
    // The alert that starts or ends a flap hold says so. The note is kept whole: it is the text that gets cut to fit.
    const flapNote = describeFlap(checkResult.flap);
    const withFlap = (text) => (flapNote ? `${text.slice(0, Math.max(0, MAX_MESSAGE - flapNote.length - 1))} ${flapNote}` : clip(text));

    if (type === 'server_down') {
        return withFlap(checkResult.error ? String(checkResult.error) : 'The server did not respond.');
    }
    if (type === 'server_recovery') {
        return withFlap(responseTime ? `Back online, responding in ${responseTime} ms.` : 'Back online.');
    }
    if (type === 'slow_response') {
        const threshold = server.monitoring?.alerts?.responseThreshold;
        const streak = Number(checkResult.slowStreak);
        // Which part was slow, when one part was most of it (utils/timings.js)
        const where = describeDominantPhase(checkResult.timings, responseTime);
        const withWhere = (text) => clip(where ? `${text} ${where}` : text);

        if (responseTime && threshold && streak > 1) return withWhere(`Slower than your ${threshold} ms limit for ${streak} checks in a row, latest ${responseTime} ms.`);
        if (responseTime && threshold) return withWhere(`Responded in ${responseTime} ms, above your ${threshold} ms limit.`);
        return responseTime ? withWhere(`Responded in ${responseTime} ms.`) : 'The server is responding slowly.';
    }
    if (isHostAlert(type)) {
        return hostAlertText({ type, host: checkResult.host, serverName: server.name })?.message ?? null;
    }
    return null;
}

const iso = (date) => (date ? new Date(date).toISOString() : null);

/**
 * A down alert in plain words (utils/diagnosis.js), or null. A row saved before the failure kind was kept has only its
 * message; when that starts "HTTP 502" the failure is read from it, anything else says nothing.
 */
const diagnosisOf = (doc) => {
    if (doc.type !== 'server_down') return null;
    const kind = doc.failureKind || (/^HTTP \d{3}\b/.test(doc.message || '') ? 'http' : null);
    return diagnose({ kind, statusCode: doc.statusCode, error: doc.message });
};

/**
 * Alerts delivered in a period, by kind, for the admin chart. `results` is what grouping by type gives: [{ _id, value }].
 * Every kind is listed, with 0 when there were none; the four host alerts (CPU, memory, disk, an agent gone quiet) are one
 * kind here, and a type this does not know is left out rather than guessed at.
 */
export function countAlertsByKind(results = []) {
    // own properties only: a bare lookup of "__proto__" or "constructor" finds Object's, not a label
    const kindOf = (type) => (Object.hasOwn(CLASSIC_LABELS, type) ? CLASSIC_LABELS[type] : (HOST_TYPES.includes(type) ? 'Host resources' : null));
    const counts = { 'Server down': 0, Recovered: 0, 'Slow response': 0, 'Host resources': 0 };
    for (const item of results) {
        const label = typeof item?._id === 'string' ? kindOf(item._id) : null;
        if (label) counts[label] += Number(item.value) || 0;
    }
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
}

const CLASSIC_LABELS = Object.freeze({ server_down: 'Server down', server_recovery: 'Recovered', slow_response: 'Slow response' });

/** The shape the app reads, both from GET /api/alerts and from the `alert:new` socket event */
export function toAlertItem(doc) {
    const diagnosis = diagnosisOf(doc);
    return {
        id: String(doc._id),
        serverId: String(doc.serverId),
        serverName: doc.serverName || 'A server',
        serverUrl: doc.serverUrl || null,
        type: doc.type,
        message: doc.message || null,
        createdAt: iso(doc.createdAt) || new Date().toISOString(),
        readAt: iso(doc.readAt),
        // only when there is something to say, so an alert without one is the shape it always was
        ...(diagnosis ? { diagnosis } : {}),
        // A host alert says which number it is about and whether this is its end, so the app can colour and word it
        ...(isHostAlert(doc.type) ? { metric: doc.metric || null, recovered: doc.recovered === true } : {}),
    };
}

/**
 * Read the feed's query string into safe values. Anything that isn't a valid id is ignored rather than
 * passed to the database.
 * @returns {{ limit: number, after: string|null, before: string|null, includeHost: boolean }}
 */
export function parseAlertQuery(query = {}) {
    const requested = parseInt(query.limit, 10);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_LIMIT));
    return {
        limit,
        after: OBJECT_ID.test(String(query.after || '')) ? String(query.after) : null,
        before: OBJECT_ID.test(String(query.before || '')) ? String(query.before) : null,
        // an app that knows the host alert types says so: ?include=host (or a list that has it)
        includeHost: String(query.include || '').split(',').map((part) => part.trim()).includes('host'),
    };
}

export default { buildAlertMessage, toAlertItem, parseAlertQuery, feedTypes, countAlertsByKind, CLASSIC_TYPES, HOST_TYPES, ALERT_CHANNEL, DEFAULT_LIMIT, MAX_LIMIT };
