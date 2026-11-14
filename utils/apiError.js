// utils/apiError.js - one shape for an error answer
//
// Errors came back in several shapes: express-validator's `{ message: 'Validation error', errors }`, the schema's version of the
// same with a `code`, most handlers' bare `{ status, message }`, limiter answers with no code, and the global handler's message
// that could be the parser's own text. A client could not tell one failure from another without matching on message text.
// Every answer from the shared layers now carries `status: 'error'`, a `message` for people and a `code` for programs.

const DEFAULT_CODES = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    405: 'METHOD_NOT_ALLOWED',
    409: 'CONFLICT',
    413: 'PAYLOAD_TOO_LARGE',
    415: 'UNSUPPORTED_MEDIA_TYPE',
    429: 'RATE_LIMITED'
};

/** The code to use for a status when the failure did not give a more specific one */
export const defaultCode = (status) => DEFAULT_CODES[status] || (status >= 500 ? 'SERVER_ERROR' : 'ERROR');

/** `{ status: 'error', message, code, ...extra }` */
export const errorBody = (message, code, extra = {}) => ({ status: 'error', message, code, ...extra });

/**
 * The answer for a request that failed validation. `message` is the first problem, in words a person can act on (clients show
 * `message`), and `errors` lists every one with the field it belongs to.
 * @param {{ field?: string, message: string }[]} errors
 */
export const validationBody = (errors) => errorBody(errors[0]?.message || 'Validation error', 'VALIDATION_ERROR', { errors });

export default { defaultCode, errorBody, validationBody };
