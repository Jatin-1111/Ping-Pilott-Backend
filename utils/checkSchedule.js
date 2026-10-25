// utils/checkSchedule.js - when check cycles run and when a server is next due
//
// The scheduler wakes up every minute, always. How often a given server is checked is its own `monitoring.frequency`;
// the wake-up interval is the finest resolution that frequency can have, so it must not depend on an env setting.
// (It used to fall back to every 3 minutes unless SMART_MONITORING_ENABLED=true, which silently turned a paid
// 1-minute monitor into a 3-minute one.)

export const CHECK_CRON = '* * * * *';
export const TICK_MS = 60 * 1000;

/** The minute a scheduler run belongs to; every schedule is counted from it. */
export const tickOf = (now = Date.now()) => new Date(Math.floor(now / TICK_MS) * TICK_MS);

/** When a server checked at `tick` is due again. A server due at or before a tick is dispatched on that tick. */
export const nextCheckSlot = (tick, frequencyMinutes) => new Date(tick.getTime() + (frequencyMinutes || 5) * TICK_MS);

// ── Spreading the checks of one tick over the minute ──
//
// Servers with the same frequency are due on the same tick, and some ticks are crowded (many servers added in one
// minute, or everything due at once after downtime). Starting them all together makes them wait for the worker's rate
// limit and for each other's DNS lookups, and that waiting is part of the response time that gets reported.
//
// Each server therefore starts at its own fixed offset into the minute. Fixed, not random: a random delay would make the
// gap between one server's checks vary by up to a minute, and uptime and slow-streak counts assume even spacing.

/** FNV-1a, 32 bit: cheap, and spreads similar strings (ObjectIds made one after another) evenly */
const fnv1a = (text) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
};

/**
 * How long into its tick this server's check starts, in ms: the same every time for the same server, from 0 up to but
 * not including `windowMs`. A server that has never been checked starts at once, so a new monitor shows its first result
 * without waiting up to a minute.
 */
export const checkOffsetMs = (server, windowMs = TICK_MS) => {
    const id = server?._id ?? server?.id;
    if (id === undefined || id === null || !server.lastChecked) return 0;
    return fnv1a(String(id)) % windowMs;
};

const PRIORITY_SCORE = { high: 1, low: 3 }; // BullMQ: lower number runs first; anything else is 2

/**
 * Options for the queue job that checks `server` on `tick`.
 * The job id includes the tick, so queueing the same server twice for one tick is a no-op.
 */
export const checkJobOptions = (server, tick) => {
    const delay = checkOffsetMs(server);
    return {
        priority: PRIORITY_SCORE[server.priority] ?? 2,
        jobId: `check-${server._id}-${new Date(tick).getTime()}`,
        ...(delay > 0 ? { delay } : {})
    };
};

export default { CHECK_CRON, TICK_MS, tickOf, nextCheckSlot, checkOffsetMs, checkJobOptions };
