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

        // Log errors
        if (statusCode >= 400) {
            logger.error(`Error response: ${method} ${path} - ${statusCode} - ${duration.toFixed(2)}ms`, {
                method,
                path,
                duration: `${duration.toFixed(2)}ms`,
                statusCode
            });
        }
    });

    next();
};

/**
 * Track metrics for monitoring
 * Can be extended to send to monitoring services like DataDog, New Relic, etc.
 */
export const trackMetrics = {
    requestCount: 0,
    errorCount: 0,
    totalResponseTime: 0,
    slowRequests: 0,

    increment(metric) {
        this[metric]++;
    },

    addResponseTime(time) {
        this.totalResponseTime += time;
        this.requestCount++;
        if (time > 1000) {
            this.slowRequests++;
        }
    },

    getAverageResponseTime() {
        return this.requestCount > 0
            ? (this.totalResponseTime / this.requestCount).toFixed(2)
            : 0;
    },

    getStats() {
        return {
            totalRequests: this.requestCount,
            totalErrors: this.errorCount,
            slowRequests: this.slowRequests,
            averageResponseTime: `${this.getAverageResponseTime()}ms`,
            errorRate: this.requestCount > 0
                ? `${((this.errorCount / this.requestCount) * 100).toFixed(2)}%`
                : '0%'
        };
    },

    reset() {
        this.requestCount = 0;
        this.errorCount = 0;
        this.totalResponseTime = 0;
        this.slowRequests = 0;
    }
};

export default performanceMonitoring;
