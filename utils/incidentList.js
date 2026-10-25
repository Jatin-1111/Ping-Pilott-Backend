// utils/incidentList.js - turns a user's incident rows into what the Incidents page shows
//
// Pure functions (no database), so the summary and paging rules can be tested on their own.

const DAY_MS = 24 * 60 * 60 * 1000;

export const PERIOD_DAYS = [7, 30];
export const DEFAULT_DAYS = 7;

export const periodStart = (days, now = Date.now()) => new Date(now - days * DAY_MS);

const ms = (date) => new Date(date).getTime();

/** The part of an incident that falls inside the period, in milliseconds. Ongoing ones run until now. */
export const downtimeWithin = (incident, since, now = Date.now()) => {
    const start = Math.max(ms(incident.startedAt), since.getTime());
    const end = Math.min(incident.endedAt ? ms(incident.endedAt) : now, now);
    return Math.max(0, end - start);
};

/**
 * @param {Array} rows     incidents of one user, newest first (lean documents)
 * @param {Array} servers  that user's servers: { _id, name, url }
 * @param {Object} options { status: 'all'|'ongoing'|'resolved', days, page, limit, now }
 *
 * The summary describes the whole period and ignores the status filter, so the filter chips can show
 * "All 12 / Ongoing 1 / Resolved 11" and stay put while you switch between them.
 */
export function buildIncidentList(rows, servers, { status = 'all', days = DEFAULT_DAYS, page = 1, limit = 20, now = Date.now() } = {}) {
    const since = periodStart(days, now);
    const inPeriod = rows.filter((r) => r.open || ms(r.startedAt) >= since.getTime());
    const byId = new Map(servers.map((s) => [String(s._id), s]));

    const summary = {
        total: inPeriod.length,
        ongoing: inPeriod.filter((r) => r.open).length,
        downtimeMs: inPeriod.reduce((sum, r) => sum + downtimeWithin(r, since, now), 0),
    };

    const filtered =
        status === 'ongoing' ? inPeriod.filter((r) => r.open) : status === 'resolved' ? inPeriod.filter((r) => !r.open) : inPeriod;

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const pageRows = filtered.slice((page - 1) * limit, page * limit);

    const incidents = pageRows.map((r) => {
        const server = byId.get(String(r.serverId));
        return {
            id: String(r._id),
            serverId: String(r.serverId),
            serverName: server?.name || 'Deleted server',
            serverUrl: server?.url || null,
            startedAt: r.startedAt,
            endedAt: r.endedAt || null,
            ongoing: !!r.open,
            // an ongoing incident has no final length yet: the page counts it up from startedAt
            durationMs: r.open ? null : Math.max(0, ms(r.endedAt) - ms(r.startedAt)),
            error: r.error || null,
            failureKind: r.failureKind || null,
        };
    });

    return { incidents, summary, pagination: { page, limit, total, totalPages } };
}

export default { PERIOD_DAYS, DEFAULT_DAYS, periodStart, downtimeWithin, buildIncidentList };
