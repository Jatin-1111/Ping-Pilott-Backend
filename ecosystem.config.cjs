// Hostnames are resolved on libuv's thread pool (4 threads by default). Checks run 50 at a time, and a lookup for a dead
// name holds a thread until the resolver gives up, so a bigger pool keeps healthy lookups from waiting behind it.
const threadPool = { UV_THREADPOOL_SIZE: "16" };

module.exports = {
    apps: [
        {
            name: "ping-pilot-api",
            script: "./index.js",
            instances: 1, // Also runs the scheduler (cron), so keep this at 1 or checks are dispatched twice
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: "development",
                RUN_WORKERS: "false", // the worker apps below do the checking and alerting
                ...threadPool,
            },
            env_production: {
                NODE_ENV: "production",
                RUN_WORKERS: "false",
                ...threadPool,
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
