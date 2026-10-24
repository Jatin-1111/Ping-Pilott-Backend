// utils/retentionMode.js - which midnight data cleanup runs
//
//   selective   delete checks older than CHECK_DATA_RETENTION_DAYS (default 7). Keeps history: the default.
//   aggressive  delete ALL check history every midnight (dashboards then only ever show "since midnight")
//   emergency   delete everything, including job logs
//
// Only selective keeps what the dashboard's history and uptime figures are built from, so it is what you get unless
// DATA_RETENTION_MODE says otherwise. A typo falls back to selective rather than to something that deletes data.

export const RETENTION_MODES = ['selective', 'aggressive', 'emergency'];
export const DEFAULT_RETENTION_MODE = 'selective';

const JOB_FOR_MODE = {
    selective: 'selectiveDataRetention',
    aggressive: 'aggressiveDataRetention',
    emergency: 'emergencyCleanup',
};

/**
 * @param {string|undefined} value  the raw DATA_RETENTION_MODE
 * @returns {{ mode: string, recognized: boolean }} recognized is false when a value was given but isn't a mode
 */
export function resolveRetentionMode(value) {
    const wanted = String(value ?? '').trim().toLowerCase();
    if (!wanted) return { mode: DEFAULT_RETENTION_MODE, recognized: true };
    if (RETENTION_MODES.includes(wanted)) return { mode: wanted, recognized: true };
    return { mode: DEFAULT_RETENTION_MODE, recognized: false };
}

export const retentionJobName = (mode) => JOB_FOR_MODE[mode] || JOB_FOR_MODE[DEFAULT_RETENTION_MODE];

export default { RETENTION_MODES, DEFAULT_RETENTION_MODE, resolveRetentionMode, retentionJobName };
