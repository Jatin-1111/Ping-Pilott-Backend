// Hostnames are resolved on libuv's thread pool (4 threads by default). Checks run 50 at a time, and a lookup for a dead
// name holds a thread until the resolver gives up, so a bigger pool keeps healthy lookups from waiting behind it.
const threadPool = { UV_THREADPOOL_SIZE: "16" };

module.exports = {
    apps: [
        {
            name: "ping-pilot-api",
            script: "./index.js",
            // The scheduler is its own app below, so this CAN be raised above 1. Before doing that: set
            // RATE_LIMIT_STORE=redis (limits are per process otherwise), and give Socket.IO sticky sessions at the proxy
            // (its long-polling handshake must reach the same instance), or use websocket-only clients.
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: "development",
                RUN_WORKERS: "false", // the worker apps below do the checking and alerting
                RUN_SCHEDULER: "false", // ping-pilot-scheduler below runs the cron jobs
                ...threadPool,
            },
            env_production: {
                NODE_ENV: "production",
                RUN_WORKERS: "false",
                RUN_SCHEDULER: "false",
                ...threadPool,
            }
        },
        {
            // The cron jobs. Exactly ONE instance: they must run once, not once per process.
            name: "ping-pilot-scheduler",
            script: "./workers/scheduler.js",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '512M',
            env: {
                NODE_ENV: "development",
            },
            env_production: {
                NODE_ENV: "production",
            }
        },
        {
            name: "ping-pilot-worker",
            script: "./workers/monitorWorker.js",
            instances: 2, // Each instance runs 50 checks at a time; raise this rather than "max" unless you need it
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: "development",
                ...threadPool,
            },
            env_production: {
                NODE_ENV: "production",
                ...threadPool,
            }
        },
        {
            // Without this process alert jobs pile up in Redis and no email or webhook is ever sent
            name: "ping-pilot-alert-worker",
            script: "./workers/alertWorker.js",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '512M',
            env: {
                NODE_ENV: "development",
            },
            env_production: {
                NODE_ENV: "production",
            }
        }
    ]
};
