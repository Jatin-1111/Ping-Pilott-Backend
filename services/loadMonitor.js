// services/loadMonitor.js - is this process keeping up with its own work?
//
// A check is timed from the moment the request is made until its response is noticed. If this process's event loop is
// stalled in between (50 checks running at once, a burst of other work), the response sits waiting and the check reads
// slower than the server was. This watches how late a timer fires, so a slow check that was measured
// during a stall can be set aside instead of counted against the user's server (see utils/alertDecision.js).
//
// It also keeps a minute's worth of DNS phase times and event-loop lag, for the one summary line a minute. Those numbers
// say whether lookups are queueing (the thread pool, utils/threadPool.js) or the loop is overloaded, before anyone
// has to guess.
//
// LOOP_LAG_SUSPECT_MS   how late the loop may run before a slow check is set aside (default 250, 0 switches it off)

import { performance } from 'perf_hooks';

export const DEFAULT_LAG_LIMIT_MS = 250;
const PROBE_MS = 25;   // how often the probe timer is set to fire
const SAMPLE_MS = 250; // how often the worst lateness seen is filed away
const RETAIN_MS = 30 * 1000;

/** The lag, in ms, from which a slow check is set aside. 0 means never. */
export const loopLagLimitMs = (env = process.env) => {
    if (env.LOOP_LAG_SUSPECT_MS === undefined) return DEFAULT_LAG_LIMIT_MS;
    const parsed = parseInt(env.LOOP_LAG_SUSPECT_MS, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_LAG_LIMIT_MS;
};

/** Nearest-rank percentile of a list of numbers; null for an empty list */
export const percentile = (values, p) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
};

/**
 * The real lag source: a timer that sets itself to fire every PROBE_MS and notes how much later than that it did. While
 * the loop is stalled the timer cannot fire, so it fires late, by the length of the stall; that is exactly what a check's
 * response callback would have suffered. (perf_hooks' monitorEventLoopDelay was tried first and did not record a 400 ms
 * stall on the machine this was written on, so it is not relied on.)
 * The timers phase runs before the I/O callbacks in the same loop pass, so the lateness is filed before the response
 * that was waiting behind the stall is handled.
 */
const timerProbe = () => {
    let worst = 0;
    let expected = performance.now() + PROBE_MS;
    let timer = null;

    const tick = () => {
        const at = performance.now();
        worst = Math.max(worst, at - expected);
        expected = at + PROBE_MS;
        timer = setTimeout(tick, PROBE_MS);
        timer.unref?.();
    };
    timer = setTimeout(tick, PROBE_MS);
    timer.unref?.();

    return {
        peek: () => worst, // the worst lateness since the last read, without clearing it
        read: () => { const value = worst; worst = 0; return value; },
        stop: () => clearTimeout(timer)
    };
};

/**
 * @param {Object} [p]  everything is replaceable in tests
 * @param {() => number} [p.now]     a monotonic clock in ms (performance.now)
 * @param {() => { peek: Function, read: Function, stop?: Function }} [p.source]  where lag comes from
 * @param {number} [p.intervalMs]    how often the lag is sampled
 * @param {number} [p.retainMs]      how far back lag samples are kept
 */
export function createLoadMonitor({ now = () => performance.now(), source = timerProbe, intervalMs = SAMPLE_MS, retainMs = RETAIN_MS } = {}) {
    let lag = null;            // { peek, read, stop }
    let timer = null;
    let buckets = [];          // { endedAt, maxLagMs }: the worst lag in each sampling period
    let minute = { dns: [], lag: [], checks: 0, setAside: 0 };

    /** Close the current sampling period. Called by the timer; tests call it by hand. */
    const sample = () => {
        if (!lag) return;
        const at = now();
        const maxLagMs = lag.read();
        buckets.push({ endedAt: at, maxLagMs });
        buckets = buckets.filter((b) => at - b.endedAt <= retainMs);
        minute.lag.push(maxLagMs);
    };

    return {
        start() {
            if (timer) return;
            lag = source();
            timer = setInterval(sample, intervalMs);
            timer.unref?.(); // never keep the process alive just for this
        },

        stop() {
            if (timer) clearInterval(timer);
            timer = null;
            lag?.stop?.();
            lag = null;
        },

        sample,

        /**
         * The worst the event loop was late at any point since `since` (a reading of the same clock), in ms. A sampling
         * period counts if it ended after `since`, and the period still open is included, so a stall in the last moments
         * of a check is not missed. That errs towards flagging, which only sets a slow sample aside.
         * 0 when the monitor has not been started.
         */
        lagSince(since) {
            if (!lag) return 0;
            let worst = lag.peek();
            for (const b of buckets) if (b.endedAt >= since && b.maxLagMs > worst) worst = b.maxLagMs;
            return Math.round(worst);
        },

        /** Note a finished check for the minute's summary */
        recordCheck(result) {
            minute.checks += 1;
            const dns = Number(result?.timings?.dns);
            if (result?.timings && Number.isFinite(dns) && dns >= 0) minute.dns.push(dns);
            if (result?.loadSuspect) minute.setAside += 1;
        },

        /** What happened since the last call, then start a new minute. null when no check finished. */
        summarize() {
            const done = minute;
            minute = { dns: [], lag: [], checks: 0, setAside: 0 };
            if (done.checks === 0) return null;
            return {
                checks: done.checks,
                setAside: done.setAside,
                dns: done.dns.length ? { p50: percentile(done.dns, 50), p95: percentile(done.dns, 95), max: Math.max(...done.dns) } : null,
                lag: done.lag.length ? { p95: Math.round(percentile(done.lag, 95)), max: Math.round(Math.max(...done.lag)) } : null
            };
        }
    };
}

/** "Checks, last minute: 118 (DNS p50 3 ms, p95 41 ms, max 220 ms; event-loop lag p95 4 ms, max 12 ms; 0 slow ones set aside)" */
export const formatSummary = (summary) => {
    if (!summary) return null;
    const dns = summary.dns ? `DNS p50 ${summary.dns.p50} ms, p95 ${summary.dns.p95} ms, max ${summary.dns.max} ms` : 'no DNS times';
    const lag = summary.lag ? `event-loop lag p95 ${summary.lag.p95} ms, max ${summary.lag.max} ms` : 'no loop lag samples';
    return `Checks, last minute: ${summary.checks} (${dns}; ${lag}; ${summary.setAside} slow ${summary.setAside === 1 ? 'one' : 'ones'} set aside while the loop was busy)`;
};

export const loadMonitor = createLoadMonitor();

export default { createLoadMonitor, loadMonitor, loopLagLimitMs, percentile, formatSummary, DEFAULT_LAG_LIMIT_MS };
