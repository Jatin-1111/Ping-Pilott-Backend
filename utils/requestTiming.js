// utils/requestTiming.js - where the time of one request went: DNS, connect, TLS, waiting for the server
//
// The agents note when each socket they create finishes each step. Which request a socket belongs to is carried by an
// AsyncLocalStorage context, not by anything inside axios: whoever calls `timedRequest` gets back the sockets that were
// created while that call ran, including one per redirect. Checks use a fresh connection each time (see
// services/monitoringService.js), so one socket is one hop.

import http from 'http';
import https from 'https';
import net from 'net';
import { AsyncLocalStorage } from 'async_hooks';
import { performance } from 'perf_hooks';

const context = new AsyncLocalStorage();

/** Record the steps of one new socket on the hop list of the request that is making it, if there is one. */
const track = (socket, host) => {
    const ctx = context.getStore();
    if (!ctx || !socket) return socket;
    // `secure`: this socket still owes a TLS handshake once it is connected (only a TLS socket can read a certificate)
    // `named`: the address is a name, so it has to be resolved first (an IP address skips DNS)
    const hop = { startedAt: performance.now(), lookupAt: null, lookupFailed: false, address: null, connectAt: null, secureAt: null, certExpiresAt: null, secure: typeof socket.getPeerCertificate === 'function', named: typeof host === 'string' && net.isIP(host) === 0 };
    ctx.hops.push(hop);
    // 'lookup' only fires for a name; it fires on failure too, with the error first
    socket.once('lookup', (err, address) => {
        hop.lookupAt = performance.now();
        if (err) hop.lookupFailed = true;
        else if (typeof address === 'string') hop.address = address;
    });
    socket.once('connect', () => { hop.connectAt = performance.now(); });
    socket.once('secureConnect', () => {
        hop.secureAt = performance.now();
        // The certificate the server presented: its expiry comes free with the handshake (utils/certExpiry.js)
        try {
            const validTo = socket.getPeerCertificate?.()?.valid_to;
            const expires = validTo ? Date.parse(validTo) : NaN;
            if (Number.isFinite(expires)) hop.certExpiresAt = expires;
        } catch {
            // a certificate that cannot be read is no certificate
        }
    });
    return socket;
};

export class TimedHttpAgent extends http.Agent {
    createConnection(...args) {
        return track(super.createConnection(...args), args[0]?.host);
    }
}

export class TimedHttpsAgent extends https.Agent {
    createConnection(...args) {
        return track(super.createConnection(...args), args[0]?.host);
    }
}

/**
 * Did the last hop get as far as being able to send the request: connected, and through the TLS handshake if there is one?
 * A request that fails after that was heard by the server (or something in front of it) and not answered.
 */
export const reachedServer = (hop) => Boolean(hop && hop.connectAt != null && (!hop.secure || hop.secureAt != null));

/**
 * The step a hop was in (or had just finished when it failed): 'dns', 'connect', 'tls' or 'response' (connected and
 * through TLS, waiting for the server to answer). null when there was no socket at all.
 */
export const stageOf = (hop) => {
    if (!hop) return null;
    if (hop.named && (hop.lookupAt == null || hop.lookupFailed)) return 'dns';
    if (hop.connectAt == null) return 'connect';
    if (hop.secure && hop.secureAt == null) return 'tls';
    return 'response';
};

/**
 * Time one request. The clock starts when `send` is called and stops when it settles (for HTTP: when the response
 * headers have arrived).
 * @param {() => Promise<any>} send  makes the request
 * @returns {Promise<{ response: any, ms: number, timings: Object|null, certExpiresAt: number|null, address: string|null }>}  rejects when `send` does,
 *   with `failedStage`, `timings` (partial: see partialTimings) and `resolvedAddress` on the error when they are known.
 *   certExpiresAt is when the certificate of the last hop expires (ms since 1970), null without TLS or a readable one.
 */
export async function timedRequest(send) {
    const ctx = { hops: [] };
    const startedAt = performance.now();
    let response;
    try {
        response = await context.run(ctx, send);
    } catch (err) {
        // Say how far the connection got, so a timeout can be told apart: never connected, or connected and not answered
        const hop = ctx.hops[ctx.hops.length - 1];
        if (err && typeof err === 'object') {
            err.reachedServer = reachedServer(hop);
            // How far it got: the steps that finished, and how long the one it stopped in had run
            err.failedStage = stageOf(hop);
            const partial = partialTimings(hop, startedAt, performance.now());
            if (partial) err.timings = partial;
            if (hop?.address) err.resolvedAddress = hop.address;
        }
        throw err;
    }
    const endedAt = performance.now();
    const last = ctx.hops[ctx.hops.length - 1];
    return {
        response,
        ms: Math.round(endedAt - startedAt),
        timings: phaseTimings(last, startedAt, endedAt),
        certExpiresAt: last?.certExpiresAt ?? null,
        address: last?.address ?? null
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

/**
 * The timings of a hop that failed: the steps that finished, and for the one it stopped in, how long it had run (a
 * name that never resolved reads as dns: 9800). Steps it never reached are left out, so `tls` missing means "never got
 * to TLS", not "no TLS". null without a socket.
 * @param {Object|undefined} hop  as in phaseTimings
 * @param {number} startedAt  when the whole request began
 * @param {number} failedAt   when it failed
 */
export function partialTimings(hop, startedAt, failedAt) {
    const stage = stageOf(hop);
    if (!stage) return null;

    const ms = (from, to) => Math.max(0, Math.round(to - from));
    const lookupAt = hop.lookupAt ?? hop.startedAt;
    const timings = { redirects: ms(startedAt, hop.startedAt) };

    if (stage === 'dns') {
        timings.dns = ms(hop.startedAt, hop.lookupAt ?? failedAt);
        return timings;
    }
    timings.dns = ms(hop.startedAt, lookupAt);
    if (stage === 'connect') {
        timings.connect = ms(lookupAt, failedAt);
        return timings;
    }
    timings.connect = ms(lookupAt, hop.connectAt);
    if (stage === 'tls') {
        timings.tls = ms(hop.connectAt, failedAt);
        return timings;
    }
    timings.tls = hop.secureAt == null ? 0 : ms(hop.connectAt, hop.secureAt);
    timings.ttfb = ms(hop.secureAt ?? hop.connectAt, failedAt);
    return timings;
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

export default { TimedHttpAgent, TimedHttpsAgent, timedRequest, phaseTimings, partialTimings, stageOf, connectTimings };
