// utils/failurePhase.js - which step of a check failed: the name lookup, the connection, the TLS handshake, the
// server's answer, or the page it answered with
//
// utils/failures.js says what kind of failure it was; utils/requestTiming.js says how far the connection got. Together
// they say where it stopped, which is what tells "the network" from "the application" when the page says "timeout".
// Pure, so every case is tested without a socket.

export const FAILED_PHASES = ['dns', 'connect', 'tls', 'response', 'content'];

const isPhase = (value) => FAILED_PHASES.includes(value);

/**
 * @param {{ kind?: string|null, stage?: string|null }} failure
 *   kind: utils/failures.js. stage: where the connection was when it failed ('dns' | 'connect' | 'tls' | 'response'),
 *   which only a failure raised by the connection itself has.
 * @returns {'dns'|'connect'|'tls'|'response'|'content'|null}  null when no step failed (the address was never checked)
 */
export function failedPhaseOf({ kind, stage } = {}) {
    const reached = isPhase(stage) ? stage : null;
    switch (kind) {
        case 'dns': return 'dns';
        case 'refused':
        case 'unreachable': return 'connect';
        case 'tls': return 'tls';
        case 'no_response':
        case 'http': return 'response';
        case 'content': return 'content';
        // A timeout never got a connection, so it is whichever step it was waiting in; a reset or an unclassified error
        // is where the connection was, or the answer when that is not known.
        case 'timeout': return reached && reached !== 'response' ? reached : 'connect';
        case 'reset':
        case 'other': return reached ?? (kind === 'reset' ? 'response' : null);
        default: return null; // blocked, invalid, no failure
    }
}

export default { FAILED_PHASES, failedPhaseOf };
