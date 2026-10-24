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
            },
            env_production: {
                NODE_ENV: "production",
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
