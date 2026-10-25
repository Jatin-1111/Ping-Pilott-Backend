// utils/serverEdits.js - small rules the server routes share, kept free of the database so they can be tested

import { isWithinCheckSchedule, timezoneOf } from './schedule.js';

/** A request's `limit` as a whole number between 1 and `max`; `fallback` when it is missing or not a number. */
export const clampLimit = (raw, { max, fallback }) => {
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(1, parsed));
};

/**
 * A pasted address with the scheme and host in lower case (they are not case sensitive, so "Example.com" and
 * "example.com" are one server) and the rest, which can be, left as typed. https:// is the default and is dropped;
 * an explicit http:// is kept so plain-http sites are checked over http. Returns null when nothing is left.
 */
export const normalizeUrl = (url) => {
    let normalized = String(url ?? '').replace(/^https:\/\//i, '').replace(/\/$/, '');
    if (!normalized || normalized.length < 3) return null;

    const [, scheme = '', authority, rest] = normalized.match(/^([a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)(.*)$/i);
    normalized = `${scheme.toLowerCase()}${authority.toLowerCase()}${rest}`;
    return normalized;
};

/**
 * What to reset when a server's address changes. The old status, response time and open incident described a
 * different address, and the old schedule slot should not delay the first check of the new one.
 * (The open incident is closed separately, in the route.)
 */
export const addressChangeUpdates = () => ({
    status: 'unknown',
    error: null,
    failureKind: null,
    responseTime: null,
    slowAlerted: false,
    slowStreak: 0,
    fastStreak: 0,
    nextCheckAt: null
});

const trialEnded = (server, now) => server.uploadedPlan === 'free'
    && server.monitoring?.trialEndsAt
    && new Date(server.monitoring.trialEndsAt).getTime() < now.getTime()
    && server.uploadedRole !== 'admin';

/**
 * When the server will next be checked, for display. A server that is not being checked says why, instead of
 * "Due now" for ever.
 */
export const nextCheckEstimate = (server, now = new Date()) => {
    if (trialEnded(server, now)) return 'Paused: trial ended';
    if (!isWithinCheckSchedule(server.monitoring, timezoneOf(server), now)) return 'Outside check hours';
    if (!server.lastChecked) return 'Never checked';

    const frequency = server.monitoring?.frequency || 5; // minutes
    const nextCheck = new Date(new Date(server.lastChecked).getTime() + frequency * 60 * 1000);
    if (nextCheck <= now) return 'Due now';
    return nextCheck.toISOString();
};

export default { clampLimit, normalizeUrl, addressChangeUpdates, nextCheckEstimate };
