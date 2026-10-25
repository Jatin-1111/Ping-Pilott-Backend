// utils/failures.js - what kind of failure a check hit, as a value a program can count, not only a sentence
//
// The message a user reads is unchanged. The kind is new: it lets history, incidents, alerts and the worker's own
// numbers say "timeouts" or "DNS" instead of matching on text, and it is what tells a flaky network apart from a
// refusing server when a pattern is worth looking at.

// timeout: never got a connection in time. no_response: connected (and through TLS), then nothing came back in time.
export const FAILURE_KINDS = ['dns', 'refused', 'reset', 'timeout', 'no_response', 'unreachable', 'tls', 'http', 'content', 'blocked', 'invalid', 'other'];

// A login wall, a bot filter and a rate limit all answer while the site is alive. Say so, and say where to change it.
const ANSWERED_HINT_CODES = new Set([401, 403, 429]);

/** The server answered, but not with a status that counts as up */
export class HttpStatusError extends Error {
    constructor(statusCode, statusText) {
        const hint = ANSWERED_HINT_CODES.has(statusCode)
            ? `. The server did answer. If that is expected, add ${statusCode} to the status codes that count as up in this server's settings.`
            : '';
        super(`HTTP ${statusCode}${statusText ? `: ${statusText}` : ''}${hint}`);
        this.name = 'HttpStatusError';
        this.failureKind = 'http';
        this.statusCode = statusCode;
    }
}

/** The server answered with an accepted status, but the page failed the keyword check (utils/keyword.js) */
export class ContentError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.name = 'ContentError';
        this.failureKind = 'content';
        this.statusCode = statusCode;
    }
}

/** The saved address cannot be checked as written */
export class InvalidAddressError extends Error {
    constructor(message = 'Invalid address (expected host:port)') {
        super(message);
        this.name = 'InvalidAddressError';
        this.failureKind = 'invalid';
    }
}

const TLS_CODES = new Set([
    'EPROTO',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID'
]);
const isTlsCode = (code) => typeof code === 'string' && (TLS_CODES.has(code) || code.startsWith('ERR_SSL') || code.startsWith('ERR_TLS'));

/**
 * @param {Error} err  whatever a check threw (an axios error, a socket error, one of the classes above)
 * @param {{ timeoutSeconds?: number }} [options]  for the wording of a timeout
 * @returns {{ kind: string, message: string, statusCode: number|null }}
 *   `message` is the short sentence the user sees: it is what the check always said.
 */
export function classifyFailure(err, { timeoutSeconds = 10 } = {}) {
    if (err?.failureKind === 'http') return { kind: 'http', message: err.message, statusCode: Number.isInteger(err.statusCode) ? err.statusCode : null };
    if (err?.failureKind === 'content') return { kind: 'content', message: err.message, statusCode: Number.isInteger(err.statusCode) ? err.statusCode : null };
    if (err?.failureKind === 'invalid') return { kind: 'invalid', message: err.message, statusCode: null };
    if (err?.code === 'PRIVATE_TARGET') return { kind: 'blocked', message: err.message, statusCode: null };

    const result = (kind, message) => ({ kind, message, statusCode: null });
    switch (err?.code) {
        case 'ECONNREFUSED': return result('refused', 'Connection refused');
        case 'ECONNRESET': return result('reset', 'Connection reset by the server');
        case 'ENOTFOUND':
        case 'EAI_AGAIN': return result('dns', 'DNS lookup failed (host not found)');
        case 'ETIMEDOUT':
        case 'ECONNABORTED':
        case 'ERR_CANCELED':
            // utils/requestTiming.js marks an error when the connection was up before it timed out
            return err.reachedServer === true
                ? result('no_response', `Connected, but no response after ${timeoutSeconds}s`)
                : result('timeout', `Timed out after ${timeoutSeconds}s`);
        case 'EHOSTUNREACH':
        case 'ENETUNREACH': return result('unreachable', 'Host unreachable');
        default: return result(isTlsCode(err?.code) ? 'tls' : 'other', err?.message || 'Request failed');
    }
}

/** { kind, statusCode? } as stored on a check result, or null when there was no failure */
export const failureOf = (classified) => (classified
    ? { kind: classified.kind, ...(classified.statusCode ? { statusCode: classified.statusCode } : {}) }
    : null);

export default { FAILURE_KINDS, HttpStatusError, ContentError, InvalidAddressError, classifyFailure, failureOf };
