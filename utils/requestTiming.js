// utils/requestTiming.js - where the time of one request went: DNS, connect, TLS, waiting for the server
//
// The agents note when each socket they create finishes each step. Which request a socket belongs to is carried by an
// AsyncLocalStorage context, not by anything inside axios: whoever calls `timedRequest` gets back the sockets that were
// created while that call ran, including one per redirect. Checks use a fresh connection each time (see
// services/monitoringService.js), so one socket is one hop.

import http from 'http';
import https from 'https';
import { AsyncLocalStorage } from 'async_hooks';
import { performance } from 'perf_hooks';

const context = new AsyncLocalStorage();

/** Record the steps of one new socket on the hop list of the request that is making it, if there is one. */
const track = (socket) => {
    const ctx = context.getStore();
    if (!ctx || !socket) return socket;
    const hop = { startedAt: performance.now(), lookupAt: null, connectAt: null, secureAt: null };
    ctx.hops.push(hop);
    // 'lookup' only fires for a name: an IP address skips DNS
    socket.once('lookup', () => { hop.lookupAt = performance.now(); });
    socket.once('connect', () => { hop.connectAt = performance.now(); });
    socket.once('secureConnect', () => { hop.secureAt = performance.now(); });
    return socket;
};

export class TimedHttpAgent extends http.Agent {
    createConnection(...args) {
        return track(super.createConnection(...args));
    }
}

export class TimedHttpsAgent extends https.Agent {
    createConnection(...args) {
        return track(super.createConnection(...args));
    }
}

/**
 * Time one request. The clock starts when `send` is called and stops when it settles (for HTTP: when the response
 * headers have arrived).
 * @param {() => Promise<any>} send  makes the request
 * @returns {Promise<{ response: any, ms: number, timings: Object|null }>}  rejects when `send` does
 */
export async function timedRequest(send) {
    const ctx = { hops: [] };
    const startedAt = performance.now();
    const response = await context.run(ctx, send);
    const endedAt = performance.now();
    return {
        response,
        ms: Math.round(endedAt - startedAt),
        timings: phaseTimings(ctx.hops[ctx.hops.length - 1], startedAt, endedAt)
    };
}

/**
 * Split the time of the last hop into phases, in whole ms. `redirects` is whatever came before that hop: earlier hops
 * and the moment before the first socket. Without a hop (nothing was connected) there is nothing to report.
 * dns is 0 for an IP address and tls is 0 without TLS. The phases add up to the total to within rounding (about 2 ms).
 * @param {{ startedAt, lookupAt, connectAt, secureAt }|undefined} hop  performance.now() readings
 * @param {number} startedAt  when the whole request began
 * @param {number} endedAt    when the response headers arrived
 */
export function phaseTimings(hop, startedAt, endedAt) {
    if (!hop) return null;
    const lookupAt = hop.lookupAt ?? hop.startedAt; // no lookup: an address, or the resolver answered from a cache
    const connectAt = hop.connectAt ?? lookupAt;
    const readyAt = hop.secureAt ?? connectAt; // the point from which the request itself can be sent

    const ms = (from, to) => Math.max(0, Math.round(to - from));
    return {
        dns: ms(hop.startedAt, lookupAt),
        connect: ms(lookupAt, connectAt),
        tls: hop.secureAt == null ? 0 : ms(connectAt, hop.secureAt),
        ttfb: ms(readyAt, endedAt),
        redirects: ms(startedAt, hop.startedAt)
    };
}

/** A plain socket's phases (a TCP check has no request): dns and connect */
export function connectTimings(hop, connectedAt) {
    if (!hop) return null;
    const lookupAt = hop.lookupAt ?? hop.startedAt;
    return {
        dns: Math.max(0, Math.round(lookupAt - hop.startedAt)),
        connect: Math.max(0, Math.round(connectedAt - lookupAt))
    };
}

export default { TimedHttpAgent, TimedHttpsAgent, timedRequest, phaseTimings, connectTimings };
