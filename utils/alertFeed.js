// utils/alertFeed.js - what an alert looks like to the mobile app, and how its feed is queried
//
// Pure functions (no database), so the message wording, the payload shape and the paging rules can be tested alone.

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

    if (type === 'server_down') {
        return checkResult.error ? clip(checkResult.error) : 'The server did not respond.';
    }
    if (type === 'server_recovery') {
        return responseTime ? `Back online, responding in ${responseTime} ms.` : 'Back online.';
    }
    if (type === 'slow_response') {
        const threshold = server.monitoring?.alerts?.responseThreshold;
        if (responseTime && threshold) return `Responded in ${responseTime} ms, above your ${threshold} ms limit.`;
        return responseTime ? `Responded in ${responseTime} ms.` : 'The server is responding slowly.';
    }
    return null;
}

const iso = (date) => (date ? new Date(date).toISOString() : null);

/** The shape the app reads, both from GET /api/alerts and from the `alert:new` socket event */
export function toAlertItem(doc) {
    return {
        id: String(doc._id),
        serverId: String(doc.serverId),
        serverName: doc.serverName || 'A server',
        serverUrl: doc.serverUrl || null,
        type: doc.type,
        message: doc.message || null,
        createdAt: iso(doc.createdAt) || new Date().toISOString(),
        readAt: iso(doc.readAt),
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
