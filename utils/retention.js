// utils/retention.js - how long check history is kept
//
// One rule: checks older than CHECK_DATA_RETENTION_DAYS are deleted each midnight (tasks/dataRetention.js).
// The default is 30 days: the longest period the apps offer (the 30d view), and the length of the TTL index on
// ServerCheck, which stays as a backstop. It used to default to 7 days, so the 30 day view and its uptime figure
// were really 7 days, and there were two more modes (aggressive, emergency) that deleted every check.

export const DEFAULT_RETENTION_DAYS = 30;
/** The TTL index on ServerCheck deletes after 30 days whatever this says, so a longer setting would not be honoured */
export const MAX_RETENTION_DAYS = 30;

/**
 * @param {string|undefined} value  the raw CHECK_DATA_RETENTION_DAYS
 * @returns {{ days: number, recognized: boolean }}  recognized is false when a value was given that cannot be used
 */
export function resolveRetentionDays(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return { days: DEFAULT_RETENTION_DAYS, recognized: true };

    const days = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (days >= 1 && days <= MAX_RETENTION_DAYS) return { days, recognized: true };
    return { days: DEFAULT_RETENTION_DAYS, recognized: false };
}

/** A message when DATA_RETENTION_MODE is set to something that no longer exists, else null */
export function legacyRetentionModeNotice(value) {
    const mode = String(value ?? '').trim().toLowerCase();
    if (!mode || mode === 'selective') return null;
    return `DATA_RETENTION_MODE="${value}" is no longer used. The aggressive and emergency modes were removed; check history older than CHECK_DATA_RETENTION_DAYS is deleted each midnight and nothing else.`;
}

export default { DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS, resolveRetentionDays, legacyRetentionModeNotice };
