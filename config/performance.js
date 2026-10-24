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
