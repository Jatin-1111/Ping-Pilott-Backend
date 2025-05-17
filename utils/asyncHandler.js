/**
 * Async error handler middleware for Express routes
 * Eliminates the need for try/catch blocks in route handlers
 * @param {Function} fn - The async route handler function
 * @returns {Function} - Express middleware function
 */
export const asyncHandler = (fn) => {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};

export default asyncHandler;