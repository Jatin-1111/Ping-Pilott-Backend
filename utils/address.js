// utils/address.js - spotting and hiding usernames and passwords inside a monitored address
//
// A "database" monitor accepts connection-style addresses (postgres://host:5432), so people paste the whole connection
// string, password included. The address is then stored as it was typed and copied into every alert email, the in-app
// feed, webhook payloads and the admin list.

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

const parse = (target) => {
    const raw = String(target ?? '').trim();
    try {
        return new URL(SCHEME.test(raw) ? raw : `tcp://${raw}`);
    } catch {
        return null;
    }
};

/**
 * True when the address carries a username or password: "postgres://app:secret@db.example.com", "user@host:22".
 * An "@" later in the path or query ("https://example.com/@team", "example.com?mail=a@b.com") is not a credential.
 */
export const containsCredentials = (target) => {
    const url = parse(target);
    if (url) return Boolean(url.username || url.password);
    // Not parseable as an address: look at the part before the first "/", "?" or "#"
    const authority = String(target ?? '').trim().replace(SCHEME, '').split(/[/?#]/)[0];
    return authority.includes('@');
};

/** The address with any username and password replaced by ***, for anything that leaves the account (alerts, feeds). */
export const maskCredentials = (target) => {
    if (typeof target !== 'string') return target;
    // The credentials end at the last "@" before the first "/", "?" or "#" (a password may itself contain "@")
    if (SCHEME.test(target)) return target.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/i, '$1***@');
    return target.replace(/^[^\s/?#]*@/, '***@');
};

const WEB_TYPES = new Set(['website', 'api']);

/**
 * Why this address cannot be monitored as this type, or null when it can. The SSRF guard decides WHERE an address may point; this
 * decides whether it is an address of the right kind at all. Without it `file:///etc/passwd` was saved as a website monitor, a TCP
 * monitor could have port 0 or 65536, and a tab character was kept inside a URL: none of them can ever be checked.
 * @param {string} type    website | api | tcp | database
 * @param {string} target  the address as typed
 */
export function targetProblem(type, target) {
    const raw = String(target ?? '').trim();
    if (/[\s\u0000-\u001f\u007f]/.test(raw)) return 'The address cannot contain spaces or control characters.';

    const scheme = (raw.match(/^([a-z][a-z0-9+.-]*):\/\//i) || [])[1]?.toLowerCase();

    if (WEB_TYPES.has(type)) {
        if (scheme && scheme !== 'http' && scheme !== 'https') {
            return 'Websites and APIs are checked over http or https. Use an http:// or https:// address, or just the host name.';
        }
        const url = parse(scheme ? raw : `https://${raw}`, 'https');
        return url?.hostname ? null : 'That does not look like a valid address.';
    }

    // tcp and database: host, and an optional port that has to be a real one
    const port = raw.replace(SCHEME, '').match(/^(?:\[[^\]]*\]|[^/:?#]*)(?::(\d*))?/)?.[1];
    if (port !== undefined && !(Number(port) >= 1 && Number(port) <= 65535)) return 'The port must be a number from 1 to 65535.';
    const url = parse(raw);
    return url?.hostname ? null : 'Enter the host and port, for example db.example.com:5432.';
}

export default { containsCredentials, maskCredentials, targetProblem };
