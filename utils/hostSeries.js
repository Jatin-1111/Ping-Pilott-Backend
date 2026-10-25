// utils/hostSeries.js - turning stored host snapshots into what a chart needs
//
// Raw snapshots (models/HostMetric.js) are kept for 24 hours. Every 5 minutes a job rolls the finished 5-minute stretches
// into one row each (models/HostMetric5m.js: averages, and the worst moment for CPU, memory and disks), which are kept
// for 30 days. Short ranges read raw points, long ones read those rows and fold them into bigger steps so a chart never
// has more than a few hundred points. Everything here is pure (no database), so every case is tested on its own.

export const BUCKET_MS = 5 * 60 * 1000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How far back each range goes, where it reads from, and the step of the points it returns (0: one per snapshot) */
export const PERIODS = {
    '1h': { rangeMs: HOUR, source: 'raw', binMs: 0 },
    '6h': { rangeMs: 6 * HOUR, source: 'raw', binMs: 0 },
    '24h': { rangeMs: DAY, source: 'rollup', binMs: BUCKET_MS },
    '7d': { rangeMs: 7 * DAY, source: 'rollup', binMs: 30 * MINUTE },
    '30d': { rangeMs: 30 * DAY, source: 'rollup', binMs: 2 * HOUR }
};
export const DEFAULT_PERIOD = '24h';

/** An agent that has not reported for this long is shown as offline (the alert for it comes later, at 5 minutes) */
export const OFFLINE_AFTER_MS = 3 * MINUTE;

export const bucketStart = (time) => Math.floor(new Date(time).getTime() / BUCKET_MS) * BUCKET_MS;

const round = (value, places = 1) => {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
};
export const percentOf = (used, total) => (Number.isFinite(used) && Number.isFinite(total) && total > 0 ? round((used / total) * 100) : 0);

const avg = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const present = (values) => values.filter((v) => Number.isFinite(v));
const ms = (value) => new Date(value).getTime();

/** The disks of one snapshot, with how full each is */
const disksOf = (row) => (Array.isArray(row.disks) ? row.disks.map((d) => ({ mount: d.mount, total: d.total, used: d.used, pct: percentOf(d.used, d.total) })) : []);

// ── from stored rows to chart points ──

/**
 * A chart point from one raw snapshot.
 * @returns {{ t: number, n: number, cpu: number, cpuMax: number, memPct: number, memPctMax: number, swapPct: number|null,
 *            load1: number|null, rxBps: number|null, txBps: number|null, disks: Array<{ mount: string, pct: number }> }}
 */
export function pointFromRaw(row) {
    const memPct = percentOf(row.memUsed, row.memTotal);
    return {
        t: ms(row.timestamp),
        n: 1,
        cpu: round(row.cpu),
        cpuMax: round(row.cpu),
        memPct,
        memPctMax: memPct,
        swapPct: Number.isFinite(row.swapTotal) ? percentOf(row.swapUsed, row.swapTotal) : null,
        load1: Number.isFinite(row.load1) ? row.load1 : null,
        rxBps: Number.isFinite(row.rxBps) ? row.rxBps : null,
        txBps: Number.isFinite(row.txBps) ? row.txBps : null,
        disks: disksOf(row).map((d) => ({ mount: d.mount, pct: d.pct }))
    };
}

/** A chart point from one stored 5-minute row (same shape as pointFromRaw) */
export const pointFromRollup = (doc) => ({
    t: ms(doc.bucket),
    n: doc.n || 1,
    cpu: doc.cpu,
    cpuMax: doc.cpuMax,
    memPct: doc.memPct,
    memPctMax: doc.memPctMax,
    swapPct: doc.swapPct ?? null,
    load1: doc.load1 ?? null,
    rxBps: doc.rxBps ?? null,
    txBps: doc.txBps ?? null,
    disks: Array.isArray(doc.disks) ? doc.disks.map((d) => ({ mount: d.mount, pct: d.pct })) : []
});

// ── rolling raw snapshots into 5-minute rows ──

/**
 * One stretch of snapshots from one server, as the row that is stored for it.
 * Averages for what is steady (CPU, memory, load, network), the worst moment for what matters when it spikes, and for
 * each disk the fullest it got. The last uptime and memory size, since those are states, not rates.
 * @param {Array} rows  raw snapshots in one bucket of one server (at least one)
 */
export function rollupBucket(rows) {
    const cpus = rows.map((r) => r.cpu);
    const mems = rows.map((r) => percentOf(r.memUsed, r.memTotal));
    const swaps = present(rows.map((r) => (Number.isFinite(r.swapTotal) ? percentOf(r.swapUsed, r.swapTotal) : NaN)));
    const loads = present(rows.map((r) => r.load1));
    const rx = present(rows.map((r) => r.rxBps));
    const tx = present(rows.map((r) => r.txBps));
    const last = rows[rows.length - 1];

    const worst = new Map();
    for (const row of rows) {
        for (const d of disksOf(row)) {
            const seen = worst.get(d.mount);
            if (!seen || d.pct > seen.pct) worst.set(d.mount, { mount: d.mount, total: d.total, pct: d.pct });
        }
    }

    return {
        n: rows.length,
        cpu: round(avg(cpus)),
        cpuMax: round(Math.max(...cpus)),
        memPct: round(avg(mems)),
        memPctMax: round(Math.max(...mems)),
        ...(swaps.length ? { swapPct: round(avg(swaps)) } : {}),
        ...(loads.length ? { load1: round(avg(loads), 2) } : {}),
        ...(rx.length ? { rxBps: Math.round(avg(rx)) } : {}),
        ...(tx.length ? { txBps: Math.round(avg(tx)) } : {}),
        disks: [...worst.values()],
        memTotal: last.memTotal,
        uptimeSec: last.uptimeSec
    };
}

/**
 * Roll raw snapshots (any servers, any order) into one stored row per server and 5-minute bucket.
 * @returns {Array<{ serverId: any, bucket: Date }&ReturnType<typeof rollupBucket>>}
 */
export function rollupRows(rows) {
    const groups = new Map();
    for (const row of rows) {
        const bucket = bucketStart(row.timestamp);
        const key = `${String(row.serverId)}|${bucket}`;
        if (!groups.has(key)) groups.set(key, { serverId: row.serverId, bucket, rows: [] });
        groups.get(key).rows.push(row);
    }
    return [...groups.values()]
        .map(({ serverId, bucket, rows: inBucket }) => ({
            serverId,
            bucket: new Date(bucket),
            ...rollupBucket(inBucket.sort((a, b) => ms(a.timestamp) - ms(b.timestamp)))
        }))
        .sort((a, b) => a.bucket - b.bucket);
}

// ── folding points into bigger steps ──

const weighted = (points, key) => {
    const have = points.filter((p) => Number.isFinite(p[key]));
    if (have.length === 0) return null;
    const weight = have.reduce((sum, p) => sum + p.n, 0);
    return have.reduce((sum, p) => sum + p[key] * p.n, 0) / weight;
};

/**
 * Fold points into steps of `binMs`: each step's averages weigh every point by how many snapshots it stands for, its
 * maximums are the worst of the points, and each disk is the fullest it got. Points must be in time order.
 * @returns {Array} points of the same shape, `t` being the start of the step
 */
export function binPoints(points, binMs) {
    if (!binMs) return points;
    const bins = new Map();
    for (const p of points) {
        const start = Math.floor(p.t / binMs) * binMs;
        if (!bins.has(start)) bins.set(start, []);
        bins.get(start).push(p);
    }
    return [...bins.entries()].map(([t, group]) => {
        const disks = new Map();
        for (const p of group) for (const d of p.disks) disks.set(d.mount, Math.max(disks.get(d.mount) ?? 0, d.pct));
        const rounded = (key, places = 1) => { const v = weighted(group, key); return v === null ? null : round(v, places); };
        return {
            t,
            n: group.reduce((sum, p) => sum + p.n, 0),
            cpu: rounded('cpu'),
            cpuMax: round(Math.max(...group.map((p) => p.cpuMax))),
            memPct: rounded('memPct'),
            memPctMax: round(Math.max(...group.map((p) => p.memPctMax))),
            swapPct: rounded('swapPct'),
            load1: rounded('load1', 2),
            rxBps: weighted(group, 'rxBps') === null ? null : Math.round(weighted(group, 'rxBps')),
            txBps: weighted(group, 'txBps') === null ? null : Math.round(weighted(group, 'txBps')),
            disks: [...disks.entries()].map(([mount, pct]) => ({ mount, pct }))
        };
    }).sort((a, b) => a.t - b.t);
}

/**
 * The points of a long range: the stored 5-minute rows, plus the snapshots since the last of them (the job runs every
 * few minutes, so the newest stretch is not rolled yet and would otherwise be missing from the end of the chart), then
 * folded into the range's step.
 * @param {Array} rollups  stored rows in range, oldest first
 * @param {Array} tail     raw snapshots newer than the last rollup's bucket (see tailStart), oldest first
 */
export function longRangePoints(rollups, tail, binMs) {
    const points = [
        ...rollups.map(pointFromRollup),
        ...rollupRows(tail).map(pointFromRollup)
    ].sort((a, b) => a.t - b.t);
    return binPoints(points, binMs);
}

/** Where raw snapshots not yet in a rollup start: the end of the newest rolled bucket, or the start of the range */
export const tailStart = (rollups, rangeStart) => (rollups.length ? ms(rollups[rollups.length - 1].bucket) + BUCKET_MS : rangeStart);

// ── the latest reading and the agent's state ──

/** The newest snapshot, in full: what the page shows as "now" */
export function latestOf(row) {
    if (!row) return null;
    return {
        t: ms(row.timestamp),
        cpu: round(row.cpu),
        cores: row.cores ?? null,
        load: [row.load1, row.load5, row.load15].every((v) => Number.isFinite(v)) ? [row.load1, row.load5, row.load15] : null,
        mem: { used: row.memUsed, total: row.memTotal, pct: percentOf(row.memUsed, row.memTotal) },
        swap: Number.isFinite(row.swapTotal) ? { used: row.swapUsed, total: row.swapTotal, pct: percentOf(row.swapUsed, row.swapTotal) } : null,
        disks: disksOf(row),
        rxBps: Number.isFinite(row.rxBps) ? row.rxBps : null,
        txBps: Number.isFinite(row.txBps) ? row.txBps : null,
        uptimeSec: Number.isFinite(row.uptimeSec) ? row.uptimeSec : null,
        procs: Array.isArray(row.procs) ? row.procs.map((p) => ({ name: p.name, cpu: p.cpu, mem: p.mem })) : []
    };
}

/**
 * Where an agent is in its life, for the page: 'off' (not turned on), 'waiting' (on, never heard from), 'connected', or
 * 'offline' (heard from, but not lately).
 */
export function agentStatus(agent, now = Date.now()) {
    if (!agent?.enabled) return 'off';
    if (!agent.lastSeenAt) return 'waiting';
    return now - ms(agent.lastSeenAt) <= OFFLINE_AFTER_MS ? 'connected' : 'offline';
}

/** The mount points that appear in a series, in the order they first do */
export const mountsOf = (points) => [...new Set(points.flatMap((p) => p.disks.map((d) => d.mount)))];

export default { BUCKET_MS, PERIODS, DEFAULT_PERIOD, OFFLINE_AFTER_MS, bucketStart, percentOf, pointFromRaw, pointFromRollup, rollupBucket, rollupRows, binPoints, longRangePoints, tailStart, latestOf, agentStatus, mountsOf };
