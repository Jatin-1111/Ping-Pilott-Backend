// utils/hostMetrics.js - what a host agent may send, checked before anything is stored
//
// The agent runs on somebody's server and the endpoint is open to anyone holding a token, so nothing it sends is trusted:
// the shape is strict (unknown fields are refused, not ignored), every number has a range, every list a length, every
// string a length and no control characters. The server's own clock decides when a snapshot happened; the agent's is
// believed only when it is close, so a wrong clock cannot write into the past or the future.
// Pure functions (no database), so every case can be tested on its own.

import { z } from 'zod';

export const MAX_SNAPSHOTS = 10;
export const MAX_DISKS = 16;
export const MAX_PROCESSES = 5;
/** How far back an agent's own timestamp is believed (a replay after an outage), and how far ahead (clock drift) */
export const MAX_AGE_MS = 15 * 60 * 1000;
export const MAX_AHEAD_MS = 60 * 1000;
/** What the agent is told to use between snapshots, and the oldest agent that is still welcome */
export const INTERVAL_SECONDS = 60;
export const MIN_AGENT_VERSION = '0.1.0';

export const hostMetricsEnabled = () => process.env.HOST_METRICS_ENABLED === 'true';

const PRINTABLE = /^[^\u0000-\u001f\u007f]+$/;
const text = (max) => z.string().min(1).max(max).regex(PRINTABLE, 'No control characters');

const percent = z.number().min(0).max(100);
const bytes = z.number().int().min(0).max(1e16);
const count = z.number().min(0).max(1e6);

const pair = z.strictObject({ total: bytes, used: bytes }).refine((p) => p.used <= p.total, 'used is more than total');

const snapshot = z.strictObject({
    ts: z.string().datetime({ offset: true }).optional(),
    cpu: z.strictObject({
        percent,
        cores: z.number().int().min(1).max(4096),
        load: z.tuple([count, count, count]).optional()
    }),
    mem: pair,
    swap: pair.optional(),
    disks: z.array(z.strictObject({ mount: text(64), total: bytes, used: bytes }).refine((d) => d.used <= d.total, 'used is more than total')).max(MAX_DISKS),
    net: z.strictObject({ rxBps: bytes, txBps: bytes }).optional(),
    uptimeSec: z.number().int().min(0).max(1e10),
    // A process can use more than 100% of one core, up to every core
    procs: z.array(z.strictObject({ name: text(64), cpu: z.number().min(0).max(409600), mem: percent })).max(MAX_PROCESSES).optional()
});

const body = z.strictObject({
    v: z.literal(1),
    host: z.strictObject({
        name: text(64).optional(),
        os: text(32).optional(),
        arch: text(16).optional(),
        agentVersion: text(24).optional()
    }).optional(),
    snapshots: z.array(snapshot).min(1).max(MAX_SNAPSHOTS)
});

/**
 * @param {unknown} raw  the request body
 * @param {number} [now]  ms since 1970 (replaceable in tests)
 * @returns {{ ok: true, host: Object, points: Object[] } | { ok: false, issues: Array<{ path: string, message: string }> }}
 *   points are in time order, shaped as stored (models/HostMetric.js), without the server id. issues never repeat what was sent.
 */
export function parseIngest(raw, now = Date.now()) {
    const parsed = body.safeParse(raw);
    if (!parsed.success) {
        return { ok: false, issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })) };
    }

    const points = parsed.data.snapshots.map((s) => {
        const claimed = s.ts ? Date.parse(s.ts) : NaN;
        const believed = Number.isFinite(claimed) && claimed >= now - MAX_AGE_MS && claimed <= now + MAX_AHEAD_MS;
        return {
            timestamp: new Date(believed ? claimed : now),
            cpu: round(s.cpu.percent),
            cores: s.cpu.cores,
            ...(s.cpu.load ? { load1: round(s.cpu.load[0], 2), load5: round(s.cpu.load[1], 2), load15: round(s.cpu.load[2], 2) } : {}),
            memTotal: s.mem.total,
            memUsed: s.mem.used,
            ...(s.swap ? { swapTotal: s.swap.total, swapUsed: s.swap.used } : {}),
            disks: s.disks,
            ...(s.net ? { rxBps: s.net.rxBps, txBps: s.net.txBps } : {}),
            uptimeSec: s.uptimeSec,
            ...(s.procs ? { procs: s.procs.map((p) => ({ name: p.name, cpu: round(p.cpu), mem: round(p.mem) })) } : {})
        };
    }).sort((a, b) => a.timestamp - b.timestamp);

    return { ok: true, host: parsed.data.host ?? {}, points };
}

function round(value, places = 1) {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
}

// ── what the owner is shown to install the agent ──

const BASE_URL = /^https?:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/;
const SAFE_TOKEN = /^ppa_[0-9a-f]{24}_[A-Za-z0-9_-]{43}$/;
export const AGENT_IMAGE = 'ghcr.io/jatin-1111/pingpilot-agent';

/**
 * The address of this API as the agent should use it: PUBLIC_API_URL when set, otherwise the one the request came to.
 * Only a plain address (scheme, host, optional port) is accepted, because it ends up inside a command that people paste
 * into a terminal: anything with a space, a quote, a path or a ; in it is refused rather than escaped.
 * @returns {string|null}
 */
export function apiBaseOf({ configured, protocol, host } = {}) {
    for (const candidate of [configured, protocol && host ? `${protocol}://${host}` : null]) {
        if (typeof candidate !== 'string') continue;
        const trimmed = candidate.trim().replace(/\/+$/, '');
        if (BASE_URL.test(trimmed)) return trimmed;
    }
    return null;
}

/**
 * The commands that install the agent with this token: one for a Linux server, one for a host that runs containers.
 * Nothing is built from anything but the token (checked here) and the address (apiBaseOf), so nothing in them can be more
 * than it looks like. null when either is not safe to put in a command.
 * @returns {{ command: string, docker: string }|null}
 */
export function installCommands({ token, base } = {}) {
    if (typeof token !== 'string' || !SAFE_TOKEN.test(token) || typeof base !== 'string' || !BASE_URL.test(base)) return null;
    return {
        command: `curl -fsSL ${base}/install.sh | sudo PINGPILOT_TOKEN=${token} sh -s -- --api ${base}`,
        docker: `docker run -d --name pingpilot-agent --restart unless-stopped --pid=host --net=host --uts=host -v /:/host:ro -e PINGPILOT_HOST_ROOT=/host -e PINGPILOT_API=${base} -e PINGPILOT_TOKEN=${token} ${AGENT_IMAGE}`
    };
}

export default { MAX_SNAPSHOTS, MAX_DISKS, MAX_PROCESSES, MAX_AGE_MS, MAX_AHEAD_MS, INTERVAL_SECONDS, MIN_AGENT_VERSION, hostMetricsEnabled, parseIngest, apiBaseOf, installCommands };
