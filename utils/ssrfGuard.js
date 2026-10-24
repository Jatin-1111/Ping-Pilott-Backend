// utils/ssrfGuard.js
// Ping Pilott makes requests to addresses its users type in (monitored URLs, TCP hosts, webhooks).
// Without a guard a user can aim those requests at the server's own network: localhost, the cloud
// metadata endpoint (169.254.169.254), Redis, MongoDB, other containers. This module blocks every
// private, loopback and link-local destination, at three points:
//   1. `safeLookup`      - plugged into http/https agents and net.connect, so the address that is
//                          actually connected to is checked (this also defeats DNS rebinding).
//   2. `assertPublicHost` - a pre-flight check, needed for IP literals (which skip DNS) and used to
//                          give users a clear message when they save a private address.
//   3. `blockPrivateRedirect` - axios `beforeRedirect` hook, for redirects to IP literals.
// Set ALLOW_PRIVATE_TARGETS=true to switch it off (for example when developing against localhost).

import dns from 'dns';
import net from 'net';

export const allowPrivateTargets = () => process.env.ALLOW_PRIVATE_TARGETS === 'true';

export class PrivateTargetError extends Error {
    constructor(host) {
        super(`Blocked: ${host} is a private or internal address. Monitor a public address instead.`);
        this.name = 'PrivateTargetError';
        this.code = 'PRIVATE_TARGET';
    }
}

const isPrivateV4 = (ip) => {
    const [a, b, c] = ip.split('.').map(Number);
    return (
        a === 0 || // "this" network
        a === 10 || // private
        a === 127 || // loopback
        (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
        (a === 169 && b === 254) || // link-local, cloud metadata
        (a === 172 && b >= 16 && b <= 31) || // private
        (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
        (a === 192 && b === 168) || // private
        (a === 198 && (b === 18 || b === 19)) || // benchmarking
        a >= 224 // multicast and reserved
    );
};

const isPrivateV6 = (ip) => {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    // IPv4-mapped (::ffff:a.b.c.d or ::ffff:7f00:1): check the embedded IPv4 address
    if (x.startsWith('::ffff:')) {
        const tail = x.slice(7);
        return tail.includes('.') ? isPrivateV4(tail) : true;
    }
    const first = parseInt(x.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // unique-local fc00::/7, link-local fe80::/10
};

/** True when `ip` (a literal address) must not be contacted. */
export const isBlockedAddress = (ip) => {
    const family = net.isIP(ip);
    if (family === 4) return isPrivateV4(ip);
    if (family === 6) return isPrivateV6(ip);
    return false;
};

/** "https://www.shop.example.com:8080/x", "db.example.com:5432" or "[::1]:80" -> the bare host. */
export const hostFromTarget = (target = '') => {
    const raw = String(target).trim();
    try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
        return url.hostname.replace(/^\[|\]$/g, '');
    } catch {
        return '';
    }
};

/**
 * dns.lookup replacement for http.Agent / net.connect: refuses to hand back a private address.
 * Handles both calling conventions (single address, or `all: true` which Node uses for happy eyeballs).
 */
export const safeLookup = (hostname, options, callback) => {
    const opts = typeof options === 'function' ? {} : (typeof options === 'number' ? { family: options } : (options || {}));
    const cb = typeof options === 'function' ? options : callback;

    dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
        if (err) return cb(err);
        if (!allowPrivateTargets() && addresses.some((a) => isBlockedAddress(a.address))) {
            return cb(new PrivateTargetError(hostname));
        }
        if (opts.all) return cb(null, addresses);
        return cb(null, addresses[0].address, addresses[0].family);
    });
};

/**
 * Throws PrivateTargetError if `target` is, or resolves to, a private address.
 * A name that does not resolve at all is not rejected here: the real check will report it as down.
 */
export const assertPublicHost = async (target) => {
    if (allowPrivateTargets()) return;
    const host = hostFromTarget(target);
    if (!host) return;

    if (net.isIP(host)) {
        if (isBlockedAddress(host)) throw new PrivateTargetError(host);
        return;
    }
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
        throw new PrivateTargetError(host);
    }
    try {
        const addresses = await dns.promises.lookup(host, { all: true });
        if (addresses.some((a) => isBlockedAddress(a.address))) throw new PrivateTargetError(host);
    } catch (err) {
        if (err instanceof PrivateTargetError) throw err;
        // unresolved name: leave it to the actual check
    }
};

/** axios `beforeRedirect`: a redirect straight to an IP literal skips DNS, so check it here. */
export const blockPrivateRedirect = (options) => {
    const host = String(options.hostname || options.host || '').replace(/^\[|\]$/g, '');
    if (!allowPrivateTargets() && net.isIP(host) && isBlockedAddress(host)) {
        throw new PrivateTargetError(host);
    }
};

export default { safeLookup, assertPublicHost, blockPrivateRedirect, isBlockedAddress, hostFromTarget, PrivateTargetError, allowPrivateTargets };
