// utils/hostAlerts.js - when a host's numbers are worth telling the owner about, and what to say
//
// Four alerts: CPU, memory and disk usage above a limit for a while, and an agent that has gone quiet. Each tells the owner
// when it starts and when it ends, once.
//
// How it avoids crying wolf:
//   - Over the limit for a DURATION, not for one reading: the clock starts at the first reading over the limit and the
//     alert fires when readings are still over it that long after. Time the agent was not reporting does not count.
//   - A reading a little under the limit neither starts nor resets the clock, and the alert only ends once the value is
//     HYSTERESIS points under it, so a value hovering around the limit raises one alert, not twenty.
//   - When the owner cannot be told right now (alerts off, outside their alert hours) nothing is used up: the alert fires
//     at the first reading after they can be.
//
// The state lives on the server (agent.alerts) as plain numbers, so a snapshot only needs the state and the readings.
// Pure functions (no database), so every rule is tested on its own.

import { percentOf } from './hostSeries.js';

export const HOST_ALERT_TYPES = ['host_cpu_high', 'host_memory_high', 'host_disk_high', 'host_metrics_missing'];
export const isHostAlert = (type) => HOST_ALERT_TYPES.includes(type);

const TYPE_OF = { cpu: 'host_cpu_high', memory: 'host_memory_high', disk: 'host_disk_high', missing: 'host_metrics_missing' };
const METRIC_OF = Object.fromEntries(Object.entries(TYPE_OF).map(([metric, type]) => [type, metric]));
const MINUTE = 60 * 1000;

/** What an owner gets without setting anything: the numbers an on-call engineer would pick */
export const DEFAULTS = {
    enabled: true,
    cpu: { percent: 90, minutes: 5 },
    memory: { percent: 90, minutes: 5 },
    disk: { percent: 90, minutes: 2 },
    missing: { minutes: 5 }
};

export const LIMITS = { percent: [1, 100], minutes: [0, 60], missingMinutes: [2, 60] };

/** An alert ends when the value is this far under its limit */
export const HYSTERESIS = 5;
/** Readings further apart than this mean the agent was not reporting between them (it reports once a minute) */
export const GAP_MS = 3 * MINUTE;

// A number, or text that is one. null, '', true and [] are not numbers here, though Number() would call them 0 or 1: a
// saved `minutes: null` must mean "the default", not "alert at once".
const whole = (value, [min, max], fallback) => {
    const isNumeric = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
    const n = isNumeric ? Number(value) : NaN;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/**
 * The settings in force: what the owner saved over the defaults, each number kept in range. Anything missing or odd falls
 * back to the default, so a half-saved or hand-edited setting can never switch an alert off by accident.
 */
export function hostAlertSettings(saved) {
    const s = saved && typeof saved === 'object' ? saved : {};
    const part = (key) => ({
        percent: whole(s[key]?.percent, LIMITS.percent, DEFAULTS[key].percent),
        minutes: whole(s[key]?.minutes, LIMITS.minutes, DEFAULTS[key].minutes)
    });
    return {
        enabled: s.enabled !== false,
        cpu: part('cpu'),
        memory: part('memory'),
        disk: part('disk'),
        missing: { minutes: whole(s.missing?.minutes, LIMITS.missingMinutes, DEFAULTS.missing.minutes) }
    };
}

const round = (value, places = 1) => {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
};

// The reading a metric is judged on. Disk is the fullest of the disks, and says which.
const reading = (metric, point) => {
    if (metric === 'cpu') return { value: Number(point.cpu) };
    if (metric === 'memory') return { value: percentOf(point.memUsed, point.memTotal) };
    let worst = { value: -1, mount: null };
    for (const d of point.disks || []) {
        const pct = percentOf(d.used, d.total);
        if (pct > worst.value) worst = { value: pct, mount: d.mount };
    }
    return worst.value < 0 ? { value: NaN } : worst;
};

// What is using it: the busiest processes by the measure that matters for the alert
const topProcesses = (metric, point) => {
    if (metric === 'disk' || !Array.isArray(point.procs)) return [];
    const key = metric === 'cpu' ? 'cpu' : 'mem';
    return [...point.procs]
        .filter((p) => p && typeof p.name === 'string' && Number(p[key]) > 0)
        .sort((a, b) => Number(b[key]) - Number(a[key]))
        .slice(0, 3)
        .map((p) => ({ name: p.name, cpu: round(Number(p.cpu)), mem: round(Number(p.mem)) }));
};

const iso = (ms) => new Date(ms).toISOString();

/**
 * Judge new readings against the limits, and say what changed.
 * @param {Object} p
 * @param {Object} p.settings        from hostAlertSettings
 * @param {Object} [p.state]         agent.alerts as last saved
 * @param {Array}  p.points          raw readings (models/HostMetric.js), any order
 * @param {number|null} [p.previousSeenAt]  ms: when the agent last reported before these readings
 * @param {boolean} [p.canAlert]     false when the owner cannot be told now: no event is raised and none is used up
 * @returns {{ state: Object, events: Array }}  the new state to save, and the events to tell the owner about
 */
export function evaluateSnapshots({ settings, state, points, previousSeenAt = null, canAlert = true }) {
    const next = JSON.parse(JSON.stringify(state && typeof state === 'object' ? state : {}));
    const events = [];
    if (!settings.enabled || !Array.isArray(points) || points.length === 0) return { state: next, events };

    const ordered = [...points].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // The agent is reporting again after a "no metrics" alert. If the owner cannot be told yet, it stays set and is told later.
    if (next.missing?.alerted && canAlert) {
        const back = new Date(ordered[0].timestamp).getTime();
        events.push({ metric: 'missing', type: TYPE_OF.missing, recovered: true, minutes: Math.max(1, Math.round((back - (next.missing.since ?? next.missing.alertedAt ?? back)) / MINUTE)) });
        next.missing = { alerted: false };
    }

    let last = previousSeenAt;
    for (const point of ordered) {
        const t = new Date(point.timestamp).getTime();
        const gapped = last !== null && t - last > GAP_MS;

        for (const metric of ['cpu', 'memory', 'disk']) {
            const limit = settings[metric];
            const st = (next[metric] ||= { since: null, alerted: false });
            const { value, mount } = reading(metric, point);
            if (!Number.isFinite(value)) continue;

            // Time nobody was watching is not time over the limit
            if (gapped && !st.alerted) st.since = null;

            if (value >= limit.percent) {
                if (st.since === null || st.since === undefined) st.since = t;
                if (mount) st.mount = mount;
                if (!st.alerted && canAlert && t - st.since >= limit.minutes * MINUTE) {
                    events.push({
                        metric, type: TYPE_OF[metric], recovered: false, value: round(value), threshold: limit.percent, minutes: limit.minutes,
                        since: iso(st.since), ...(mount ? { mount } : {}), procs: topProcesses(metric, point)
                    });
                    st.alerted = true;
                    st.alertedAt = t;
                }
            } else if (value <= limit.percent - HYSTERESIS) {
                if (st.alerted) {
                    if (canAlert) {
                        events.push({
                            metric, type: TYPE_OF[metric], recovered: true, value: round(value), threshold: limit.percent,
                            lasted: Math.max(1, Math.round((t - (st.alertedAt ?? t)) / MINUTE)), ...(st.mount ? { mount: st.mount } : {}), procs: []
                        });
                        next[metric] = { since: null, alerted: false };
                    }
                    // else: it ended, but the owner cannot be told yet: stay alerted so the end is told later
                } else {
                    st.since = null;
                }
            }
            // between the two: nothing changes, neither the clock nor the alert
        }
        last = t;
    }
    return { state: next, events };
}

/**
 * Has the agent gone quiet for long enough to say so? Run by the sweep, since a silent agent sends nothing to react to.
 * An agent that has never reported is not "quiet": it has not been installed yet.
 * @returns {{ metric: 'missing', type: string, recovered: false, minutes: number, lastSeen: string }|null}
 */
export function missingDecision({ settings, agent, now = Date.now() }) {
    if (!settings.enabled || !agent?.enabled || !agent.lastSeenAt) return null;
    if (agent.alerts?.missing?.alerted) return null;
    const lastSeen = new Date(agent.lastSeenAt).getTime();
    if (!Number.isFinite(lastSeen)) return null;
    const quietFor = now - lastSeen;
    if (quietFor < settings.missing.minutes * MINUTE) return null;
    return { metric: 'missing', type: TYPE_OF.missing, recovered: false, minutes: Math.floor(quietFor / MINUTE), lastSeen: iso(lastSeen) };
}

/** The state after the sweep has raised the alert */
export const markMissing = (state, now = Date.now(), since = null) => ({ ...(state || {}), missing: { alerted: true, alertedAt: now, since: since ?? now } });

// ── what an event looks like when stored with a pending alert, and in words ──

const str = (value, max) => (typeof value === 'string' && value ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : undefined);
const num = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : undefined);
const date = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined);

/** An event as it is kept and sent: only known fields, each bounded. null when it is not an event at all. */
export function cleanHostAlert(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.metric !== 'string' || !Object.hasOwn(TYPE_OF, raw.metric)) return null;
    const out = { metric: raw.metric, type: TYPE_OF[raw.metric], recovered: raw.recovered === true };
    for (const key of ['value', 'threshold', 'minutes', 'lasted']) {
        const n = num(raw[key]);
        if (n !== undefined) out[key] = n;
    }
    for (const key of ['since', 'lastSeen']) {
        const d = date(raw[key]);
        if (d) out[key] = d;
    }
    const mount = str(raw.mount, 64);
    if (mount) out.mount = mount;
    if (raw.alsoDown === true) out.alsoDown = true;
    const procs = (Array.isArray(raw.procs) ? raw.procs : [])
        .map((p) => ({ name: str(p?.name, 64), cpu: num(p?.cpu), mem: num(p?.mem) }))
        .filter((p) => p.name)
        .slice(0, 3)
        .map((p) => ({ name: p.name, cpu: p.cpu ?? 0, mem: p.mem ?? 0 }));
    if (procs.length) out.procs = procs;
    return out;
}

const pct = (n) => `${Math.round(Number(n))}%`;
const minutesWord = (n) => `${n} minute${n === 1 ? '' : 's'}`;

/**
 * An alert in words, for the email, the chat message, the webhook and the app's feed to share.
 * @param {{ type: string, host: Object, serverName?: string }} p
 * @returns {{ subject: string, title: string, message: string, lines: string[], tone: 'warning'|'ok' } | null}
 */
export function hostAlertText({ type, host, serverName = 'A server' }) {
    const h = cleanHostAlert(host);
    if (!h || h.type !== type) return null;

    const thing = { cpu: 'CPU', memory: 'Memory', disk: 'Disk' }[h.metric];
    const using = (h.procs || []).map((p) => `${p.name} ${h.metric === 'cpu' ? `${Math.round(p.cpu)}% of one core` : `${p.mem.toFixed(1)}% of memory`}`);
    const lines = [];
    let message;
    let headline;

    if (h.metric === 'missing') {
        if (h.recovered) {
            headline = `The agent on ${serverName} is reporting again`;
            message = `The agent is reporting again after ${minutesWord(h.minutes ?? 1)}.`;
        } else {
            headline = `No data from the agent on ${serverName}`;
            message = `No data from the agent for ${minutesWord(h.minutes ?? 0)}${h.lastSeen ? ` (last heard ${h.lastSeen.slice(11, 16)} UTC)` : ''}.`;
            lines.push('Check that the server is running, and that the agent service is: systemctl status pingpilot-agent');
            if (h.alsoDown) lines.push('Ping Pilott’s checks also see this server as down, so the whole machine may be off.');
        }
    } else if (h.recovered) {
        headline = `${thing} on ${serverName} is back to normal`;
        const where = h.metric === 'disk' && h.mount ? ` ${h.mount}` : '';
        message = h.metric === 'disk'
            ? `Disk${where} is back to ${pct(h.value)} full.`
            : `${thing} is back to ${pct(h.value)} after ${minutesWord(h.lasted ?? 1)} above ${pct(h.threshold)}.`;
    } else if (h.metric === 'disk') {
        headline = `Disk space on ${serverName} is running out`;
        const dur = h.minutes > 0 ? ` for ${minutesWord(h.minutes)}` : '';
        message = `The disk${h.mount ? ` ${h.mount}` : ''} has been above ${pct(h.threshold)} full${dur} (now ${pct(h.value)}).`;
        lines.push('A full disk makes databases and logs fail. Free some space or grow the volume.');
    } else {
        headline = `${thing} on ${serverName} is high`;
        const dur = h.minutes > 0 ? ` for ${minutesWord(h.minutes)}` : '';
        message = `${thing} has been above ${pct(h.threshold)}${dur} (now ${pct(h.value)}).`;
        if (using.length) lines.push(`What is using it: ${using.join(', ')}.`);
    }

    const tone = h.recovered ? 'ok' : 'warning';
    const prefix = h.recovered ? '✅ RESOLVED' : '⚠️ WARNING';
    return { subject: `${prefix}: ${headline}`, title: headline, message: message.slice(0, 300), lines: [message, ...lines], tone };
}

export default {
    HOST_ALERT_TYPES, isHostAlert, DEFAULTS, LIMITS, HYSTERESIS, GAP_MS, hostAlertSettings, evaluateSnapshots, missingDecision,
    markMissing, cleanHostAlert, hostAlertText
};

export { METRIC_OF };
