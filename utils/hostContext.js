// utils/hostContext.js - what the host was doing around a failed check, as evidence for the diagnosis
//
// A check from outside sees a 504; the agent on the server saw CPU at 98% for the five minutes before it. This turns the
// raw snapshots around the failure into a small summary (summariseHost) and the readings worth mentioning (hostFindings).
// utils/diagnosisDetail.js takes both: findings become causes, and a healthy host becomes a note that points elsewhere.
//
// Pure functions (no database), so every threshold can be tested on its own.

import { pointFromRaw } from './hostSeries.js';

/** How far before the failure to look, and how far after it (the check that failed may be a little older than the reading) */
export const WINDOW_BEFORE_MS = 10 * 60 * 1000;
export const WINDOW_AFTER_MS = 60 * 1000;
/** Fewer readings than this say too little to call the host normal or busy */
export const MIN_SAMPLES = 2;

export const LIMITS = {
    cpuAvg: 85,
    cpuMax: 95,
    mem: 90,
    swap: 50,
    diskHigh: 90,
    diskFull: 97
};

const round = (n) => Math.round(n);
const ms = (value) => new Date(value).getTime();

/**
 * @param {Array} rows   raw HostMetric rows (lean) of one server
 * @param {number|Date} at  when the check failed
 * @returns {null | { samples: number, minutes: number, cpuAvg: number, cpuMax: number, memPct: number, memMax: number,
 *                    swapPct: number|null, disk: { mount: string, pct: number }|null, proc: { name: string, cpu: number }|null }}
 */
export function summariseHost(rows, at) {
    const when = ms(at);
    if (!Number.isFinite(when) || !Array.isArray(rows)) return null;

    const points = rows
        .filter((r) => r && Number.isFinite(ms(r.timestamp)) && Number.isFinite(r.cpu) && Number.isFinite(r.memTotal) && Number.isFinite(r.memUsed))
        .filter((r) => ms(r.timestamp) >= when - WINDOW_BEFORE_MS && ms(r.timestamp) <= when + WINDOW_AFTER_MS)
        .sort((a, b) => ms(a.timestamp) - ms(b.timestamp));
    if (points.length < MIN_SAMPLES) return null;

    const shaped = points.map(pointFromRaw);
    const mean = (key) => shaped.reduce((sum, p) => sum + p[key], 0) / shaped.length;
    const newest = shaped[shaped.length - 1];

    // The fullest disk at the newest reading: disks only fill, so the last one is the one that matters
    const disk = newest.disks.reduce((worst, d) => (!worst || d.pct > worst.pct ? d : worst), null);

    // The busiest process of the newest reading that has any (names only, as stored)
    const procs = points[points.length - 1].procs;
    const proc = Array.isArray(procs) && procs.length
        ? procs.reduce((top, p) => (Number.isFinite(p?.cpu) && p.name && (!top || p.cpu > top.cpu) ? { name: String(p.name), cpu: p.cpu } : top), null)
        : null;

    return {
        samples: shaped.length,
        minutes: Math.max(1, round((ms(points[points.length - 1].timestamp) - ms(points[0].timestamp)) / 60000)),
        cpuAvg: round(mean('cpu')),
        cpuMax: round(Math.max(...shaped.map((p) => p.cpuMax))),
        memPct: round(newest.memPct),
        memMax: round(Math.max(...shaped.map((p) => p.memPctMax))),
        swapPct: newest.swapPct === null ? null : round(newest.swapPct),
        disk: disk ? { mount: disk.mount, pct: round(disk.pct) } : null,
        proc
    };
}

/**
 * The readings that are high enough to be a cause, most likely first.
 * @returns {{ kind: 'cpu'|'memory'|'disk', severe: boolean, text: string, evidence: string[], check: { step: string, command?: string } }[]}
 */
export function hostFindings(host) {
    if (!host) return [];
    const found = [];
    const window = `${host.samples} readings over ${host.minutes} min`;

    if (host.cpuAvg >= LIMITS.cpuAvg || host.cpuMax >= LIMITS.cpuMax) {
        found.push({
            kind: 'cpu',
            severe: host.cpuAvg >= LIMITS.cpuAvg,
            text: 'The server was out of CPU: requests queue up or time out when every core is busy',
            evidence: [
                `CPU averaged ${host.cpuAvg}% and peaked at ${host.cpuMax}% (${window})`,
                host.proc && host.proc.cpu >= 50 ? `Busiest process: ${host.proc.name} at ${round(host.proc.cpu)}% of a core` : null
            ].filter(Boolean),
            check: { step: 'Find what is using the CPU. Look at the busiest processes on the Host metrics panel, or run this on the server.', command: 'ps aux --sort=-%cpu | head -n 8' }
        });
    }

    if (host.memMax >= LIMITS.mem || (host.swapPct !== null && host.swapPct >= LIMITS.swap)) {
        found.push({
            kind: 'memory',
            severe: host.memMax >= LIMITS.mem,
            text: 'The server was short of memory: it may have been swapping, or the system may have killed the app',
            evidence: [
                `Memory reached ${host.memMax}% (${window})`,
                host.swapPct !== null && host.swapPct >= LIMITS.swap ? `Swap was ${host.swapPct}% used` : null
            ].filter(Boolean),
            check: { step: 'Look for the app being killed for lack of memory (an "out of memory" line in the system log), and for what is using it.', command: 'dmesg -T | grep -i -E "out of memory|oom" | tail -n 5' }
        });
    }

    if (host.disk && host.disk.pct >= LIMITS.diskHigh) {
        found.push({
            kind: 'disk',
            severe: host.disk.pct >= LIMITS.diskFull,
            text: 'A disk was almost full: apps fail to write logs, sessions or uploads, and databases stop',
            evidence: [`${host.disk.mount} was ${host.disk.pct}% full`],
            check: { step: 'Find what filled the disk, then free space.', command: 'df -h && du -xh / --max-depth=2 2>/dev/null | sort -rh | head -n 12' }
        });
    }

    return found.sort((a, b) => Number(b.severe) - Number(a.severe));
}

/** True when there were enough readings and none of them is worth a cause: the host looked fine */
export const hostLooksNormal = (host) => Boolean(host) && hostFindings(host).length === 0;

/** The line shown under the diagnosis when the host looked fine, so it can rule resource exhaustion out */
export const normalNote = (host) =>
    `The host looked normal when this failed (CPU ${host.cpuAvg}%, memory ${host.memPct}%${host.disk ? `, ${host.disk.mount} ${host.disk.pct}% full` : ''}), so running out of resources is less likely.`;

export default { WINDOW_BEFORE_MS, WINDOW_AFTER_MS, MIN_SAMPLES, LIMITS, summariseHost, hostFindings, hostLooksNormal, normalNote };
