/**
 * Standard API response formatter
 * Ensures consistent API response structure
 */

/**
 * Format a success response
 * @param {Object} res - Express response object
 * @param {String} message - Success message
 * @param {*} data - Response data
 * @param {Number} statusCode - HTTP status code (default: 200)
 */
export const success = (res, message, data = null, statusCode = 200) => {
    const response = {
        status: 'success',
        message
    };

    if (data !== null) {
        response.data = data;
    }

    return res.status(statusCode).json(response);
};

/**
 * Format an error response
 * @param {Object} res - Express response object
 * @param {String} message - Error message
 * @param {Number} statusCode - HTTP status code (default: 400)
 * @param {Array|Object} errors - Validation errors (optional)
 */
export const error = (res, message, statusCode = 400, errors = null) => {
    const response = {
        status: 'error',
        message
    };

    if (errors !== null) {
        response.errors = errors;
    }

    return res.status(statusCode).json(response);
};

/**
 * Create a paginated response
 * @param {Object} res - Express response object
 * @param {String} message - Success message
 * @param {Array} data - Data array
 * @param {Number} page - Current page number
 * @param {Number} limit - Items per page
 * @param {Number} total - Total items count
 * @param {Number} statusCode - HTTP status code (default: 200)
 */
export const paginated = (res, message, data, page, limit, total, statusCode = 200) => {
    const totalPages = Math.ceil(total / limit);

    return res.status(statusCode).json({
        status: 'success',
        message,
        data,
        pagination: {
            total,
            totalPages,
            currentPage: page,
            limit,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1
        }
    });
};

/**
 * Format a not found response
 * @param {Object} res - Express response object
 * @param {String} message - Error message (default: "Resource not found")
 */
export const notFound = (res, message = 'Resource not found') => {
    return error(res, message, 404);
};

/**
 * Format an unauthorized response
 * @param {Object} res - Express response object
 * @param {String} message - Error message (default: "Unauthorized")
 */
export const unauthorized = (res, message = 'Unauthorized') => {
    return error(res, message, 401);
};

/**
 * Format a forbidden response
 * @param {Object} res - Express response object
 * @param {String} message - Error message (default: "Forbidden")
 */
export const forbidden = (res, message = 'Forbidden') => {
    return error(res, message, 403);
};

/**
 * Format a validation error response
 * @param {Object} res - Express response object
 * @param {Array|Object} errors - Validation errors
 * @param {String} message - Error message (default: "Validation error")
 */
export const validationError = (res, errors, message = 'Validation error') => {
    return error(res, message, 400, errors);
};

/**
 * Format a server error response
 * @param {Object} res - Express response object
 * @param {String} message - Error message (default: "Internal server error")
 */
export const serverError = (res, message = 'Internal server error') => {
    return error(res, message, 500);
};

export default {
    success,
    error,
    paginated,
    notFound,
    unauthorized,
    forbidden,
    validationError,
    serverError
};