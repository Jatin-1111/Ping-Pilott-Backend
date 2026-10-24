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

export default { containsCredentials, maskCredentials };
