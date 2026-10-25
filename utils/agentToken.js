// utils/agentToken.js - the token a host agent signs in with: made once, shown once, kept only as a hash
//
// ppa_<id>_<secret>. The id (24 hex characters) finds the server with one indexed lookup; the secret (32 random bytes) is
// what proves it, and only its SHA-256 is stored, so a copy of the database cannot be used to send data. The secret is
// random and long, so a plain hash is enough: there is nothing to guess and nothing to stretch.
// The token belongs to one server and can only send that server's metrics. Pure functions, no database.

import crypto from 'crypto';

const TOKEN = /^ppa_([0-9a-f]{24})_([A-Za-z0-9_-]{43})$/;

/** @returns {string} the SHA-256 of a secret, in hex */
export const hashSecret = (secret) => crypto.createHash('sha256').update(String(secret)).digest('hex');

/**
 * A new token. `token` is shown to the owner once; `tokenId` and `tokenHash` are what gets stored.
 * @returns {{ token: string, tokenId: string, tokenHash: string }}
 */
export function generateToken() {
    const tokenId = crypto.randomBytes(12).toString('hex');
    const secret = crypto.randomBytes(32).toString('base64url');
    return { token: `ppa_${tokenId}_${secret}`, tokenId, tokenHash: hashSecret(secret) };
}

/** @returns {{ tokenId: string, secret: string }|null}  null for anything that is not shaped like a token */
export function parseToken(raw) {
    const match = typeof raw === 'string' ? TOKEN.exec(raw) : null;
    return match ? { tokenId: match[1], secret: match[2] } : null;
}

/** The token from an `Authorization: Bearer ...` header, or null */
export function bearerToken(header) {
    if (typeof header !== 'string') return null;
    const [scheme, value, ...rest] = header.trim().split(/\s+/);
    return scheme?.toLowerCase() === 'bearer' && value && rest.length === 0 ? value : null;
}

// What a missing server is compared against, so a wrong id takes as long to refuse as a wrong secret
const NOTHING = hashSecret('no such agent');

/**
 * Does this secret match the stored hash? Constant time, and the same work when there is no stored hash.
 * @param {string} secret
 * @param {string|null|undefined} storedHash
 */
export function secretMatches(secret, storedHash) {
    const given = Buffer.from(hashSecret(secret), 'hex');
    const expected = Buffer.from(typeof storedHash === 'string' && /^[0-9a-f]{64}$/.test(storedHash) ? storedHash : NOTHING, 'hex');
    const equal = crypto.timingSafeEqual(given, expected);
    return equal && typeof storedHash === 'string' && storedHash.length === 64;
}

export default { hashSecret, generateToken, parseToken, bearerToken, secretMatches };
