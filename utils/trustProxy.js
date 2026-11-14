// utils/trustProxy.js - what to put in Express's `trust proxy` setting
//
// `trust proxy` decides whose X-Forwarded-For header is believed, and req.ip (which every rate limiter keys on) comes from it.
// A hop COUNT ("1") trusts whatever is directly connected: if the API port can also be reached without the proxy in front, a
// client sends its own X-Forwarded-For and picks its own req.ip, so no limit applies to it. Naming WHO is the proxy fixes that:
// 'uniquelocal' (private addresses, which is what nginx has on the Docker network) or a list of addresses or subnets.

/**
 * @param {string|undefined} value  TRUST_PROXY
 * @returns {number|boolean|string}  a hop count, a boolean, or an Express address/subnet list
 */
export function parseTrustProxy(value) {
    const text = String(value ?? '1').trim();
    if (/^\d+$/.test(text)) return parseInt(text, 10);
    if (text === 'true') return true;
    if (text === 'false') return false;
    return text; // e.g. 'uniquelocal', 'loopback, 10.0.0.0/8', an address
}

export default { parseTrustProxy };
