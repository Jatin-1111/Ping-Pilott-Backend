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

export default { CHECK_CRON, TICK_MS, tickOf, nextCheckSlot };
