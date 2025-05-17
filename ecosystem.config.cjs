module.exports = {
    apps: [
        {
            name: 'ping-pilot-api',
            script: 'index.js',
            instances: 'max',
            exec_mode: 'cluster',
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: 'production',
            },
            env_development: {
                NODE_ENV: 'development',
            },
            error_file: 'logs/pm2/error.log',
            out_file: 'logs/pm2/output.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            merge_logs: true,
        },
        {
            name: 'ping-pilot-cron',
            script: 'tasks/index.js',
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            watch: false,
            max_memory_restart: '500M',
            env: {
                NODE_ENV: 'production',
            },
            env_development: {
                NODE_ENV: 'development',
            },
            error_file: 'logs/pm2/cron-error.log',
            out_file: 'logs/pm2/cron-output.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            merge_logs: true,
        }
    ],
};