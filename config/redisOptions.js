// config/redisOptions.js - the arguments for the shared Redis connection
//
// BullMQ refuses to start a Worker unless the connection has maxRetriesPerRequest: null, and a Redis outage must not
// fail queued commands halfway. The options used to be passed only when REDIS_URL was NOT set:
//
//     new Redis(process.env.REDIS_URL || redisConfig)
//
// With a URL (Render's Key Value, docker-compose's redis://redis:6379) ioredis got just the string, kept its default of
// 20 retries, and every worker died on start with "Your redis options maxRetriesPerRequest must be null". The
// scheduler still queued checks, so logs looked healthy while nothing ever ran them. The options now go in both cases.

/** Options every connection gets, whether it is configured by URL or by host and port */
export const sharedRedisOptions = () => ({
    // BullMQ requires null
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy(times) {
        return Math.min(times * 50, 2000);
    },
});

/**
 * @param {Object} env  process.env
 * @returns {Array} arguments for `new Redis(...)`
 */
export function redisConnectionArgs(env = process.env) {
    if (env.REDIS_URL) {
        return [env.REDIS_URL, sharedRedisOptions()];
    }
    return [
        {
            host: env.REDIS_HOST || 'localhost',
            port: parseInt(env.REDIS_PORT) || 6379,
            password: env.REDIS_PASSWORD || undefined,
            ...sharedRedisOptions(),
        },
    ];
}

export default { redisConnectionArgs, sharedRedisOptions };
