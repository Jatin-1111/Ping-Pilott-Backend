// utils/alertFeed.js - what an alert looks like to the mobile app, and how its feed is queried
//
// Pure functions (no database), so the message wording, the payload shape and the paging rules can be tested alone.

import { describeDominantPhase } from './timings.js';
import { describeFlap } from './flapDamping.js';
import { diagnose } from './diagnosis.js';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
export const ALERT_CHANNEL = 'alert-events';

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
    };
}

/**
 * Read the feed's query string into safe values. Anything that isn't a valid id is ignored rather than
 * passed to the database.
 * @returns {{ limit: number, after: string|null, before: string|null }}
 */
export function parseAlertQuery(query = {}) {
    const requested = parseInt(query.limit, 10);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_LIMIT));
    return {
        limit,
        after: OBJECT_ID.test(String(query.after || '')) ? String(query.after) : null,
        before: OBJECT_ID.test(String(query.before || '')) ? String(query.before) : null,
    };
}

export default { buildAlertMessage, toAlertItem, parseAlertQuery, ALERT_CHANNEL, DEFAULT_LIMIT, MAX_LIMIT };
