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
 * How long the server itself took to answer, in ms: the time to first byte minus the time to connect.
 *
 * The TCP handshake is exactly one round trip to the server. The first byte of the response comes back one round trip
 * after the request is sent, plus whatever the server spent producing it. So ttfb is "one round trip + server time", the
 * connect is "one round trip", and the difference is the server's own time, whatever the distance between us and it.
 * What is left of the whole response time (DNS, connecting, TLS, the round trip) is the network's, and clients show it
 * as `responseTime - serverTime`.
 *
 * It describes the page the check ended on: after a redirect, the earlier pages are in `redirects`, which is not part of
 * it. null when it cannot be told (a TCP check has no response, a failed check has no timings).
 */
export const serverTimeOf = (timings) => {
    const clean = cleanTimings(timings);
    if (!clean || clean.ttfb === undefined || clean.connect === undefined) return null;
    return Math.max(0, clean.ttfb - clean.connect);
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

export default { cleanTimings, serverTimeOf, dominantPhase, describeDominantPhase };
