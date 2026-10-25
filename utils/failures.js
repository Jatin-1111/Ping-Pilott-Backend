// utils/failures.js - what kind of failure a check hit, as a value a program can count, not only a sentence
//
// The message a user reads is unchanged. The kind is new: it lets history, incidents, alerts and the worker's own
// numbers say "timeouts" or "DNS" instead of matching on text, and it is what tells a flaky network apart from a
// refusing server when a pattern is worth looking at.

export const FAILURE_KINDS = ['dns', 'refused', 'reset', 'timeout', 'unreachable', 'tls', 'http', 'blocked', 'invalid', 'other'];

/** The server answered, but not with a status that counts as up */
export class HttpStatusError extends Error {
    constructor(statusCode, statusText) {
        super(`HTTP ${statusCode}${statusText ? `: ${statusText}` : ''}`);
        this.name = 'HttpStatusError';
        this.failureKind = 'http';
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
        case 'ERR_CANCELED': return result('timeout', `Timed out after ${timeoutSeconds}s`);
        case 'EHOSTUNREACH':
        case 'ENETUNREACH': return result('unreachable', 'Host unreachable');
        default: return result(isTlsCode(err?.code) ? 'tls' : 'other', err?.message || 'Request failed');
    }
}

/** { kind, statusCode? } as stored on a check result, or null when there was no failure */
export const failureOf = (classified) => (classified
    ? { kind: classified.kind, ...(classified.statusCode ? { statusCode: classified.statusCode } : {}) }
    : null);

export default { FAILURE_KINDS, HttpStatusError, InvalidAddressError, classifyFailure, failureOf };
