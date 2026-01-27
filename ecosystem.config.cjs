module.exports = {
    apps: [
        {
            name: "ping-pilot-api",
            script: "./index.js",
            instances: 1, // API instance
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
            instances: "max", // Use all available cores for workers (or set to 2-4)
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: "development",
            },
            env_production: {
                NODE_ENV: "production",
            }
        }
    ]
};
