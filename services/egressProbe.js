// services/egressProbe.js - can this machine reach the internet at all?
//
// Every check runs from one place. If that place loses its outbound network, or its DNS, every monitored server
// "fails", gets confirmed as down by the second try (which fails too), and every owner gets a DOWN email, followed by
// a RECOVERY email when the network returns. A failed check is therefore only believed once these control targets
// answer: if they do not, the problem is ours, nothing is recorded and nobody is alerted.
//
// Healthy means at least one control address accepts a TCP connection AND a well-known name resolves.
// Settings (all optional):
//   EGRESS_PROBE=false              switch the probe off
//   EGRESS_PROBE_TARGETS=1.1.1.1:443,8.8.8.8:443   control addresses, host:port, comma separated
//   EGRESS_PROBE_DNS=cloudflare.com                the name to resolve

import net from 'net';
import dns from 'dns';
import { allowPrivateTargets } from '../utils/ssrfGuard.js';

export const DEFAULT_TARGETS = ['1.1.1.1:443', '8.8.8.8:443'];
export const DEFAULT_DNS_NAME = 'cloudflare.com';
const PROBE_TIMEOUT_MS = 3000;

export class EgressDownError extends Error {
    constructor() {
        super('Ping Pilot cannot reach the internet from here right now, so this check was not recorded. It will be tried again.');
        this.name = 'EgressDownError';
        this.code = 'EGRESS_DOWN';
    }
}

const tcpConnect = (target, timeoutMs = PROBE_TIMEOUT_MS) => new Promise((resolve, reject) => {
    const [host, port] = target.split(':');
    const socket = net.connect({ host, port: parseInt(port, 10) || 443 });
    const done = (err) => { socket.destroy(); err ? reject(err) : resolve(); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done());
    socket.once('timeout', () => done(new Error(`${target} timed out`)));
    socket.once('error', done);
});

const resolveName = (name) => dns.promises.lookup(name);

/** Settings from the environment */
export const probeSettings = (env = process.env) => ({
    enabled: env.EGRESS_PROBE !== 'false' && !allowPrivateTargets(),
    targets: (env.EGRESS_PROBE_TARGETS || '').split(',').map((t) => t.trim()).filter(Boolean).length > 0
        ? env.EGRESS_PROBE_TARGETS.split(',').map((t) => t.trim()).filter(Boolean)
        : DEFAULT_TARGETS,
    dnsName: env.EGRESS_PROBE_DNS || DEFAULT_DNS_NAME,
});

/**
 * @param {Object} [p]  everything is replaceable in tests
 * @returns {{ isUp: (maxAgeMs?: number) => Promise<boolean>, setReporter: (fn) => void, reset: () => void }}
 */
export function createEgressProbe({ settings = probeSettings, tcp = tcpConnect, lookup = resolveName, now = Date.now } = {}) {
    let last = null;        // { at, up }
    let inFlight = null;    // one probe at a time, however many failing checks ask
    let reporter = null;

    const run = async () => {
        const { targets, dnsName } = settings();
        const results = await Promise.allSettled([
            // any one control address answering is enough
            Promise.any(targets.map((target) => tcp(target))),
            lookup(dnsName),
        ]);
        const up = results.every((r) => r.status === 'fulfilled');
        last = { at: now(), up };
        try { reporter?.(up); } catch { /* reporting must never break a check */ }
        return up;
    };

    return {
        /**
         * True when the network is fine. An answer younger than `maxAgeMs` is reused, so fifty failing checks cause one probe.
         * Always true when the probe is switched off or private targets are allowed (local development).
         */
        async isUp(maxAgeMs = 15000) {
            if (!settings().enabled) return true;
            if (last && now() - last.at <= maxAgeMs) return last.up;
            if (!inFlight) inFlight = run().finally(() => { inFlight = null; });
            return inFlight;
        },
        /** Called with true or false after every real probe (the worker uses it to publish the state for /health) */
        setReporter(fn) { reporter = fn; },
        reset() { last = null; inFlight = null; },
    };
}

export const egressProbe = createEgressProbe();

export default { createEgressProbe, egressProbe, EgressDownError, probeSettings, DEFAULT_TARGETS, DEFAULT_DNS_NAME };
