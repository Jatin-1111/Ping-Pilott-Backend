// config/performance.js - Performance configuration module

/**
 * Tiered caching strategy based on data volatility
 */
export const CACHE_STRATEGIES = {
    serverList: 30,        // 30 seconds for server lists
    serverDetails: 60,     // 1 minute for individual servers
    analytics: 300,        // 5 minutes for analytics
    userProfile: 600,      // 10 minutes for user data
    staticData: 3600       // 1 hour for plans/configs
};

/**
 * Environment-specific performance configuration
 */
export const getPerformanceConfig = () => {
    const isDev = process.env.NODE_ENV === 'development';

    return {
        cache: {
            enabled: !isDev,
            ttl: {
                serverList: isDev ? 5 : CACHE_STRATEGIES.serverList,
                serverDetails: isDev ? 10 : CACHE_STRATEGIES.serverDetails,
                analytics: isDev ? 30 : CACHE_STRATEGIES.analytics,
                userProfile: isDev ? 60 : CACHE_STRATEGIES.userProfile,
                staticData: isDev ? 300 : CACHE_STRATEGIES.staticData
            }
        },
        worker: {
            concurrency: isDev ? 5 : 50,
            limiter: {
                max: isDev ? 10 : 100,
                duration: 1000
            }
        },
        database: {
            maxPoolSize: isDev ? 10 : 50,
            minPoolSize: isDev ? 2 : 10,
            maxIdleTimeMS: 30000,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000
        },
        logging: {
            level: isDev ? 'debug' : 'info',
            pretty: isDev
        },
        compression: {
            level: 6,              // Balance between speed and compression
            threshold: 1024,       // Only compress responses > 1KB
        }
    };
};

/**
 * Performance monitoring constants
 */
export const PERFORMANCE_CONFIG = {
    MAX_HISTORY_POINTS: 1440, // 24 hours at 1-minute intervals
    BATCH_CHECK_LIMIT: 10,
    QUERY_TIMEOUT: 10000, // 10 seconds
    SLOW_QUERY_THRESHOLD: 1000 // Log queries slower than 1s
};
