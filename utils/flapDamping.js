// utils/flapDamping.js - a server that keeps going up and down should not send an email each time
//
// Without this, a flaky site sends DOWN, RECOVERED, DOWN, RECOVERED, and the owner learns to ignore all of it.
//
// After FLAP_CHANGES status changes (up <-> down) within FLAP_WINDOW_MINUTES, the server is "held": the status, the
// history and the incidents stay truthful, but DOWN and RECOVERY alerts stop. The alert that starts the hold says so.
// The hold ends when the server has not changed for FLAP_STEADY_MINUTES. If it then differs from what the owner was
// last told, one alert for its current state goes out. No new alert type: the existing ones carry the context in their
// text, so installed apps that only know down, recovery and slow keep working.
//
// Settings (all optional):
//   FLAP_CHANGES=4            changes within the window that start a hold (0 switches damping off)
//   FLAP_WINDOW_MINUTES=30    how far back changes are counted
//   FLAP_STEADY_MINUTES=10    how long it must stay as it is for the hold to end
//
// The one cost: a real outage that begins while a server is held is reported up to FLAP_STEADY_MINUTES after it settles.

const MINUTE = 60 * 1000;
const KEEP_CHANGES = 10; // never store more change times than this

const wholeNumber = (raw, fallback) => {
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export const flapConfig = (env = process.env) => {
    const windowMinutes = Math.max(1, wholeNumber(env.FLAP_WINDOW_MINUTES, 30));
    const steadyMinutes = Math.max(1, wholeNumber(env.FLAP_STEADY_MINUTES, 10));
    return {
        changes: wholeNumber(env.FLAP_CHANGES, 4),
        windowMinutes,
        steadyMinutes,
        windowMs: windowMinutes * MINUTE,
        steadyMs: steadyMinutes * MINUTE
    };
};

const FLAP_STATES = ['started', 'settled'];

/** The note that travels with an alert, as stored: only known fields, whole numbers. null when there is none. */
export const cleanFlap = (flap) => {
    if (!flap || typeof flap !== 'object' || !FLAP_STATES.includes(flap.state)) return null;
    const count = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : null);
    const changes = count(flap.changes);
    const windowMinutes = count(flap.windowMinutes);
    const steadyMinutes = count(flap.steadyMinutes);
    if (!changes || !windowMinutes || !steadyMinutes) return null;
    return { state: flap.state, changes, windowMinutes, steadyMinutes };
};

/** The sentence added to a down or recovery alert, or null */
export const describeFlap = (flap) => {
    const clean = cleanFlap(flap);
    if (!clean) return null;
    if (clean.state === 'started') {
        return `It has changed state ${clean.changes} times in ${clean.windowMinutes} minutes, so further changes are held until it stays steady for ${clean.steadyMinutes} minutes.`;
    }
    return `It had been changing state repeatedly and has now been steady for ${clean.steadyMinutes} minutes.`;
};

const toMs = (value) => (value === null || value === undefined ? NaN : new Date(value).getTime());
const isUpOrDown = (status) => status === 'up' || status === 'down';
const alertFor = (status) => (status === 'down' ? 'server_down' : 'server_recovery');
/** What the owner was last told, after this alert (the status of the last down or recovery alert raised) */
const toldAfter = (alertType, before) => (alertType === 'server_down' ? 'down' : alertType === 'server_recovery' ? 'up' : before);

/**
 * Decide whether the alert for this check goes out, and the damping state to save.
 * @param {Object} p
 * @param {string} p.previous          the server's status before this check
 * @param {string} p.status            the status this check found
 * @param {string|null} p.baseAlertType what the plain rules say to send ('server_down', 'server_recovery', 'slow_response' or null)
 * @param {Object} [p.state]           { alertedStatus, statusChanges, flapHeldAt } as saved on the server (missing means none)
 * @param {Date|number} p.now
 * @param {Object} [p.config]          flapConfig()
 * @returns {{ alertType: string|null, flap: Object|null, touch: boolean, release: boolean,
 *             alertedStatus: string|null, statusChanges: number[], flapHeldAt: number|null }}
 *   `touch` says the saved damping state changes. `release` marks the alert that ends a hold: it must be written only if
 *   the server is still held, so two checks racing to end it send one alert. `flap` is the note for the alert, if any.
 */
export function dampAlert({ previous, status, baseAlertType, state = {}, now, config = flapConfig() }) {
    const time = now instanceof Date ? now.getTime() : Number(now);
    const alerted = state.alertedStatus ?? null;
    const heldAt = toMs(state.flapHeldAt);
    const held = Number.isFinite(heldAt);
    const history = (Array.isArray(state.statusChanges) ? state.statusChanges : []).map(toMs).filter(Number.isFinite);

    const result = (fields) => ({
        alertType: baseAlertType, flap: null, touch: false, release: false,
        alertedStatus: alerted, statusChanges: history, flapHeldAt: held ? heldAt : null,
        ...fields
    });
    // The alert goes out as the plain rules say: only what the owner was told is remembered
    const plain = (clearHold = false) => {
        const told = toldAfter(baseAlertType, alerted);
        return result({ alertedStatus: told, touch: told !== alerted || clearHold, flapHeldAt: clearHold ? null : (held ? heldAt : null) });
    };

    // Switched off: alerts are as they always were, and a hold left over from before is dropped
    if (!(config.changes > 0)) return plain(held);

    const isChange = isUpOrDown(previous) && isUpOrDown(status) && previous !== status;

    if (isChange) {
        const recent = history.filter((t) => time - t <= config.windowMs);
        const changes = [...recent, time].slice(-KEEP_CHANGES);

        if (held) {
            // Held: the change is recorded and nothing is sent
            return result({ alertType: null, statusChanges: changes, touch: true });
        }
        if (changes.length >= config.changes) {
            // This change starts the hold, and its alert says so
            return result({
                alertedStatus: toldAfter(baseAlertType, alerted),
                statusChanges: changes,
                flapHeldAt: time,
                touch: true,
                flap: { state: 'started', changes: changes.length, windowMinutes: config.windowMinutes, steadyMinutes: config.steadyMinutes }
            });
        }
        return result({ alertedStatus: toldAfter(baseAlertType, alerted), statusChanges: changes, touch: true });
    }

    if (!held) return plain();

    // Held, and no change on this check: has it stayed as it is long enough?
    const lastChange = history.length ? Math.max(...history) : heldAt;
    if (time - lastChange < config.steadyMs) return result({});

    // Steady: the hold ends. Tell the owner only if their last alert no longer matches
    const behind = isUpOrDown(status) && status !== alerted;
    return result({
        alertType: behind ? alertFor(status) : baseAlertType,
        alertedStatus: behind ? status : toldAfter(baseAlertType, alerted),
        statusChanges: [],
        flapHeldAt: null,
        touch: true,
        release: true,
        flap: behind ? { state: 'settled', changes: Math.max(history.length, 1), windowMinutes: config.windowMinutes, steadyMinutes: config.steadyMinutes } : null
    });
}

export default { flapConfig, dampAlert, describeFlap, cleanFlap };
