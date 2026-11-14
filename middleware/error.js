import logger from '../utils/logger.js';
import { defaultCode, errorBody } from '../utils/apiError.js';

/**
 * Custom error response class
 */
class ErrorResponse extends Error {
    constructor(message, statusCode, code) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}

/**
 * Global error handler middleware
 * @param {Error} err - Error object
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
const errorMiddleware = (err, req, res, next) => {
    let error = { ...err };
    error.message = err.message;

    // Log error for debugging
    logger.error(`Error: ${error.message}`, {
        stack: err.stack,
        path: req.originalUrl,
        method: req.method
    });

    // Mongoose validation error
    if (err.name === 'ValidationError') {
        const message = Object.values(err.errors).map(val => val.message).join(', ');
        error = new ErrorResponse(message, 400, 'VALIDATION_ERROR');
    }

    // Mongoose duplicate key error (usually for unique fields)
    if (err.code === 11000) {
        const field = Object.keys(err.keyValue)[0];
        const value = err.keyValue[field];
        const message = `Duplicate field value: ${field} with value: ${value}`;
        error = new ErrorResponse(message, 400, 'DUPLICATE');
    }

    // Mongoose cast error: a value that is not the type the field needs. In the URL's id it means there is no such
    // resource (404); anywhere else (a query parameter, a body field) the request itself is wrong (400, not 404).
    if (err.name === 'CastError') {
        error = err.path === '_id'
            ? new ErrorResponse('Resource not found', 404, 'NOT_FOUND')
            : new ErrorResponse(`Invalid value for ${err.path || 'a field'}`, 400, 'INVALID_VALUE');
    }

    // JWT errors
    if (err.name === 'JsonWebTokenError') {
        error = new ErrorResponse('Invalid token', 401, 'INVALID_TOKEN');
    }

    if (err.name === 'TokenExpiredError') {
        error = new ErrorResponse('Token expired', 401, 'TOKEN_EXPIRED');
    }

    // body-parser: malformed JSON and oversized bodies come as err.status (400/413) with a type, and its own message
    // text ("Unexpected end of JSON input") is the parser's, not something to hand to a client
    if (err.type === 'entity.parse.failed') error = new ErrorResponse('The request body is not valid JSON', 400, 'INVALID_JSON');
    if (err.type === 'entity.too.large') error = new ErrorResponse('The request body is too large', 413, 'PAYLOAD_TOO_LARGE');

    // body-parser reports malformed JSON and oversized bodies as err.status (400/413), not err.statusCode
    const clientStatus = [err.statusCode, err.status].find((c) => Number.isInteger(c) && c >= 400 && c < 500);
    const statusCode = error.statusCode || clientStatus || 500;

    // Format response. Internal error text stays in the log; clients get a generic message for 5xx in production.
    const response = errorBody(
        statusCode >= 500 && process.env.NODE_ENV === 'production'
            ? 'Server Error'
            : (error.message || 'Server Error'),
        // only a code this handler (or ErrorResponse) chose: a raw error's own code (ECONNRESET, ...) is not for clients
        error instanceof ErrorResponse && error.code ? error.code : defaultCode(statusCode)
    );

    // Add stack trace in development
    if (process.env.NODE_ENV === 'development') {
        response.stack = err.stack;
    }

    res.status(statusCode).json(response);
};

export { ErrorResponse };
export default errorMiddleware;