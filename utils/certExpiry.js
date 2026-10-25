// utils/certExpiry.js - telling an owner that the certificate of their site is about to expire, once per step
//
// Checks do not validate certificates (a self-signed staging server must not show as down), so an expired certificate
// never fails a check, though every visitor's browser will warn. This reads the expiry date from the handshake the check
// already makes and warns at 14, 7, 3 and 1 day left, and once more when it has expired. It never changes a server's
// status, and goes by email and webhook only.
//
// A "level" is the step a certificate has reached: 14, 7, 3 or 1 (the smallest of those that is at least the days left),
// or 0 once it has expired. The level the owner was last told about is stored on the server (certAlertedDays), so each
// step is told once.

export const CERT_THRESHOLDS = [14, 7, 3, 1];
const DAY_MS = 24 * 60 * 60 * 1000;
const LEVELS = [0, ...[...CERT_THRESHOLDS].reverse()]; // 0, 1, 3, 7, 14

const toMs = (value) => {
    if (value === null || value === undefined) return NaN;
    return value instanceof Date ? value.getTime() : new Date(value).getTime();
};

/** Whole days until `expiresAt`, rounding up (half a day left is 1); 0 or less once it has expired */
export const certDaysLeft = (expiresAt, now = Date.now()) => {
    const end = toMs(expiresAt);
    const at = toMs(now);
    if (!Number.isFinite(end) || !Number.isFinite(at)) return null;
    return end <= at ? 0 : Math.ceil((end - at) / DAY_MS);
};

/**
 * The step a certificate has reached: 14, 7, 3, 1, 0 (expired), or null when it is more than 14 days from expiring or
 * the date cannot be read.
 */
export const certLevel = (expiresAt, now = Date.now()) => {
    const days = certDaysLeft(expiresAt, now);
    if (days === null) return null;
    if (days === 0) return 0;
    return [...CERT_THRESHOLDS].reverse().find((threshold) => days <= threshold) ?? null;
};

/**
 * Should the owner be told now, and what is the level to remember afterwards?
 * @param {Object} p
 * @param {Date|string|number|null} p.expiresAt
 * @param {number|null} [p.alertedLevel]  the level the owner was last told about, or null
 * @param {Date|number} p.now
 * @param {boolean} [p.enabled]           the server's setting (monitoring.alerts.certExpiry, on unless turned off)
 * @returns {{ level: number|null, alert: boolean, nextAlertedLevel: number|null }}
 *   When the owner has turned the warning off, a level is not used up: turning it on again tells them at that level.
 */
export function decideCertAlert({ expiresAt, alertedLevel = null, now, enabled = true }) {
    const alerted = Number.isFinite(alertedLevel) ? alertedLevel : null;
    const days = certDaysLeft(expiresAt, now);
    // No readable date: nothing to say and nothing learned
    if (days === null) return { level: null, alert: false, nextAlertedLevel: alerted };

    const level = certLevel(expiresAt, now);
    // Far from expiring: a renewed certificate starts a new cycle, so every step is told again next time
    if (level === null) return { level, alert: false, nextAlertedLevel: null };

    if (alerted === null || level < alerted) {
        return enabled
            ? { level, alert: true, nextAlertedLevel: level }
            : { level, alert: false, nextAlertedLevel: alerted };
    }
    // Renewed to a certificate that is closer to expiry than the one the owner was warned about last: they have acted
    // on it, so this counts as handled, and the next step down is told as usual
    if (level > alerted) return { level, alert: false, nextAlertedLevel: level };
    return { level, alert: false, nextAlertedLevel: alerted };
}

/**
 * What to write for a check that saw a certificate, or null when nothing about the warnings changes.
 * The write is guarded by the level it was judged against, so two checks racing to warn send one alert.
 * @returns {{ filter: Object, $set: Object, alert: { level: number, daysLeft: number, expiresAt: Date } | null } | null}
 */
export function planCertUpdate({ server, checkResult, now }) {
    const expiresAt = checkResult?.certExpiresAt;
    if (!expiresAt) return null;

    const alerted = Number.isFinite(server.certAlertedDays) ? server.certAlertedDays : null;
    const decision = decideCertAlert({
        expiresAt,
        alertedLevel: alerted,
        now,
        enabled: server.monitoring?.alerts?.certExpiry !== false
    });
    if (!decision.alert && decision.nextAlertedLevel === alerted) return null;

    return {
        filter: { _id: server._id, certAlertedDays: alerted },
        $set: { certAlertedDays: decision.nextAlertedLevel },
        alert: decision.alert ? { level: decision.level, daysLeft: certDaysLeft(expiresAt, now), expiresAt: new Date(toMs(expiresAt)) } : null
    };
}

/** The note that travels with a certificate alert, as stored: expiresAt (ISO), daysLeft and level. null when unusable. */
export const cleanCert = (cert) => {
    if (!cert || typeof cert !== 'object') return null;
    const expires = toMs(cert.expiresAt);
    const daysLeft = Number(cert.daysLeft);
    const level = Number(cert.level);
    if (!Number.isFinite(expires) || !Number.isFinite(daysLeft) || daysLeft < 0 || !LEVELS.includes(level)) return null;
    return { expiresAt: new Date(expires).toISOString(), daysLeft: Math.round(daysLeft), level };
};

export default { CERT_THRESHOLDS, certDaysLeft, certLevel, decideCertAlert, planCertUpdate, cleanCert };
