import logger from '../utils/logger.js';

/**
 * Custom error response class
 */
class ErrorResponse extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
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
        error = new ErrorResponse(message, 400);
    }

    // Mongoose duplicate key error (usually for unique fields)
    if (err.code === 11000) {
        const field = Object.keys(err.keyValue)[0];
        const value = err.keyValue[field];
        const message = `Duplicate field value: ${field} with value: ${value}`;
        error = new ErrorResponse(message, 400);
    }

    // Mongoose bad ObjectId
    if (err.name === 'CastError') {
        const message = `Resource not found${err.path ? ` with id: ${err.value}` : ''}`;
        error = new ErrorResponse(message, 404);
    }

    // JWT errors
    if (err.name === 'JsonWebTokenError') {
        error = new ErrorResponse('Invalid token', 401);
    }

    if (err.name === 'TokenExpiredError') {
        error = new ErrorResponse('Token expired', 401);
    }

    // Default to 500 if no status code
    const statusCode = error.statusCode || 500;

    // Format response
    const response = {
        status: 'error',
        message: error.message || 'Server Error',
    };

    // Add stack trace in development
    if (process.env.NODE_ENV === 'development') {
        response.stack = err.stack;
    }

    res.status(statusCode).json(response);
};

export { ErrorResponse };
export default errorMiddleware;