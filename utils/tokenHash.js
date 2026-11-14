// utils/tokenHash.js - e-mail verification and password-reset tokens
//
// The token in the e-mailed link used to be stored in the database as it was sent (a UUID), so anyone who could read the
// database, a backup or a log line could take over an account that had an open reset. Now only a SHA-256 hash is stored: the
// link carries the token, the database holds its hash, and a presented token is hashed and compared in constant time.
//
// Tokens issued before this change are still stored as plain UUIDs. They are recognised by their shape and compared as before,
// so links already sent keep working until they expire (at most 24 hours). A stored value that looks like a hash is never
// compared as plain text, so a leaked hash cannot be presented as a token.

import crypto from 'node:crypto';

const HASHED = /^[0-9a-f]{64}$/;

export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** A new token to put in the link (43 URL-safe characters, 256 bits). Store hashToken(token), never the token. */
export const newEmailToken = () => crypto.randomBytes(32).toString('base64url');

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

/**
 * @param {string|undefined} stored    what the database holds (a hash, or a plain token issued before hashing)
 * @param {string|undefined} presented what came in the request
 */
export function tokenMatches(stored, presented) {
    if (typeof stored !== 'string' || typeof presented !== 'string' || !stored || !presented) return false;
    if (HASHED.test(stored)) return safeEqual(stored, hashToken(presented));
    return safeEqual(stored, presented); // issued before hashing; expires within 24 hours of the change
}

export default { hashToken, newEmailToken, tokenMatches };
