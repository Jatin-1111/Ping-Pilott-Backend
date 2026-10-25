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

const WINDOW_15_MIN = 15 * 60 * 1000;
const tooMany = (message) => ({ status: 'error', message });
const emailKey = (req) => `${req.ip}:${String(req.body?.email || '').toLowerCase().trim()}`;

/**
 * General API limiter, per IP. Generous: a dashboard polls every minute and several people can share
 * an office IP. It exists to stop floods, not to meter normal use.
 */
export const apiLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 300,
    message: tooMany('Too many requests, please slow down and try again in a minute')
});

/**
 * Sign-in and sign-up: slows password guessing. Keyed by IP + email, so one attacker cannot lock out
 * everyone behind the same IP, and a successful login does not count against the limit.
 */
export const authLimiter = createRateLimiter({
    windowMs: WINDOW_15_MIN,
    max: parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10) || 10,
    keyGenerator: emailKey,
    skipSuccessfulRequests: true,
    message: tooMany('Too many attempts, please try again in 15 minutes')
});

/**
 * Endpoints that send an email (verification, password reset). Stops them being used to flood
 * someone's inbox or burn the SMTP quota: 5 per hour per address.
 */
export const emailLimiter = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 5,
    keyGenerator: emailKey,
    message: tooMany('We already sent several emails to this address. Please wait an hour before asking again')
});

/**
 * Token endpoints (verify email, reset password, refresh): per IP, to stop token guessing.
 */
export const tokenLimiter = createRateLimiter({
    windowMs: WINDOW_15_MIN,
    max: 30,
    message: tooMany('Too many attempts, please try again later')
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
    emailLimiter,
    tokenLimiter,
    createUserRateLimiter,
    createRateLimiter
};
/**
 * Public status pages. The web app's server fetches these on behalf of every visitor, so the requests of many people
 * arrive from one address: the limit is per address and page, and high. Caching (a minute, in the handler and in the web
 * app) is what keeps the load down; this only stops a flood against one page.
 */
export const publicStatusLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: parseInt(process.env.PUBLIC_STATUS_RATE_LIMIT_MAX, 10) || 600,
    keyGenerator: (req) => `${req.ip}:${String(req.params?.slug || '').toLowerCase()}`,
    message: tooMany('Too many requests, please try again in a minute')
});
