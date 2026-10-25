// utils/timings.js - pure helpers for the per-phase timings stored with a check, and for saying them in an alert

const PHASES = [
    ['dns', 'DNS lookup'],
    ['connect', 'connecting'],
    ['tls', 'the TLS handshake'],
    ['ttfb', "the server's response"],
    ['redirects', 'redirects']
];

/**
 * The timings as stored: only the known phases, each a finite non-negative number. null when there is nothing usable,
 * so a check without timings has no `timings` field at all.
 */
export const cleanTimings = (timings) => {
    if (!timings || typeof timings !== 'object') return null;
    const clean = {};
    for (const [key] of PHASES) {
        const value = Number(timings[key]);
        if (timings[key] !== undefined && timings[key] !== null && Number.isFinite(value) && value >= 0) clean[key] = Math.round(value);
    }
    return Object.keys(clean).length > 0 ? clean : null;
};

/**
 * The phase that took most of the time, when it took at least half of it. Below that no single phase explains the delay,
 * and saying so would only mislead.
 * @param {Object} timings
 * @param {number} [totalMs]  the response time; the phases' own sum when it is missing
 * @returns {{ phase: string, label: string, ms: number, total: number }|null}
 */
export const dominantPhase = (timings, totalMs) => {
    const clean = cleanTimings(timings);
    if (!clean) return null;

    const sum = Object.values(clean).reduce((a, b) => a + b, 0);
    const total = Number(totalMs) > 0 ? Math.round(Number(totalMs)) : sum;
    if (!(total > 0)) return null;

    let best = null;
    for (const [key, label] of PHASES) {
        if (clean[key] !== undefined && (best === null || clean[key] > best.ms)) best = { phase: key, label, ms: clean[key], total };
    }
    return best && best.ms * 2 >= total ? best : null;
};

/** "Most of the time was spent on DNS lookup (820 of 1240 ms)." or null */
export const describeDominantPhase = (timings, totalMs) => {
    const top = dominantPhase(timings, totalMs);
    return top ? `Most of the time was spent on ${top.label} (${top.ms} of ${top.total} ms).` : null;
};

export default { cleanTimings, dominantPhase, describeDominantPhase };
