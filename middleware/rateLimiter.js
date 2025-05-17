import rateLimit from 'express-rate-limit';

/**
 * Create a rate limiter middleware
 * @param {Object} options - Rate limiter options
 * @returns {Function} Rate limiter middleware
 */
const createRateLimiter = (options = {}) => {
    const defaultOptions = {
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 100, // Limit each IP to 100 requests per window
        standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
        legacyHeaders: false, // Disable the `X-RateLimit-*` headers
        message: {
            status: 'error',
            message: 'Too many requests, please try again later',
        }
    };

    return rateLimit({
        ...defaultOptions,
        ...options,
    });
};

/**
 * Standard API rate limiter
 * Limits requests to 100 per 15 minutes
 */
export const apiLimiter = createRateLimiter();

/**
 * Authentication routes rate limiter
 * More strict: 10 requests per 15 minutes
 */
export const authLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: {
        status: 'error',
        message: 'Too many authentication attempts, please try again after 15 minutes',
    }
});

/**
 * User-specific limiter based on user ID
 * Use this for routes that should be limited per user, not per IP
 */
export const createUserRateLimiter = (options = {}) => {
    const defaultOptions = {
        windowMs: 15 * 60 * 1000,
        max: 100,
        keyGenerator: (req) => {
            // Use user ID as key if authenticated, otherwise IP
            return req.user ? req.user.id : req.ip;
        },
        message: {
            status: 'error',
            message: 'Too many requests, please try again later',
        }
    };

    return rateLimit({
        ...defaultOptions,
        ...options
    });
};

export default {
    apiLimiter,
    authLimiter,
    createUserRateLimiter,
    createRateLimiter
};