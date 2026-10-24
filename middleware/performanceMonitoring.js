// middleware/performanceMonitoring.js - Performance monitoring middleware

import logger from '../utils/logger.js';
import { performance } from 'perf_hooks';

/**
 * Performance monitoring middleware
 * Tracks API response times and logs slow queries
 */
export const performanceMonitoring = (req, res, next) => {
    const start = performance.now();
    const path = req.path;
    const method = req.method;

    // Capture response finish event
    res.on('finish', () => {
        const duration = performance.now() - start;
        const statusCode = res.statusCode;

        // Log all requests in development
        if (process.env.NODE_ENV === 'development') {
            logger.debug(`${method} ${path} - ${statusCode} - ${duration.toFixed(2)}ms`);
        }

        // Log slow requests (> 1000ms)
        if (duration > 1000) {
            logger.warn(`Slow request detected: ${method} ${path} - ${duration.toFixed(2)}ms`, {
                method,
                path,
                duration: `${duration.toFixed(2)}ms`,
                statusCode,
                userAgent: req.get('user-agent')
            });
        }

        // Only 5xx are errors. A wrong password or an expired token (401/404) is normal traffic; logging it as an
        // error buried the real ones (3,600 lines of it in error.log).
        if (statusCode >= 500) {
            logger.error(`Error response: ${method} ${path} - ${statusCode} - ${duration.toFixed(2)}ms`, {
                method,
                path,
                duration: `${duration.toFixed(2)}ms`,
                statusCode
            });
        } else if (statusCode >= 400 && statusCode !== 401 && statusCode !== 404) {
            logger.warn(`Client error: ${method} ${path} - ${statusCode} - ${duration.toFixed(2)}ms`);
        }
    });

    next();
};

export default performanceMonitoring;
