import cron from 'node-cron';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

// Load environment variables
dotenv.config();

// Import logger and database connection
import logger from '../utils/logger.js';
import { connectDB } from '../config/db.js';
import CronJob from '../models/CronJob.js';

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Track active jobs to prevent overlap
const activeJobs = new Map();

/**
 * Initialize cron jobs
 * This is the main entry point for the cron job manager
 */
export const initCronJobs = async () => {
    try {
        // Connect to database
        await connectDB();
        logger.info('Connected to MongoDB for cron jobs');

        // Make sure logs directory exists
        const logsDir = path.join(__dirname, '../logs/cron');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }

        // Create job to check servers
        scheduleServerChecks();

        // Create job for data retention (cleanup old data)
        scheduleDataRetention();

        // Create job for daily reports
        scheduleDailyReports();

        logger.info('All cron jobs initialized successfully');
    } catch (error) {
        logger.error(`Error initializing cron jobs: ${error.message}`);
        process.exit(1);
    }
};

/**
 * Schedule server checking jobs
 */
const scheduleServerChecks = () => {
    // Run every minute
    const job = cron.schedule('* * * * *', async () => {
        const jobName = 'check-servers';

        // Don't run if already running
        if (activeJobs.get(jobName)) {
            logger.warn(`Job ${jobName} is already running, skipping this execution`);
            return;
        }

        // Set job as active
        activeJobs.set(jobName, true);

        // Log start in database
        const cronJobLog = new CronJob({
            name: jobName,
            status: 'running',
            startedAt: new Date(),
        });

        await cronJobLog.save();

        try {
            logger.info(`Running job: ${jobName}`);

            // Import dynamically to avoid circular dependencies
            const { checkAllServers } = await import('./checkServers.js');

            // Execute the job
            const result = await checkAllServers();

            // Log completion
            cronJobLog.status = 'completed';
            cronJobLog.completedAt = new Date();
            cronJobLog.result = result;
            await cronJobLog.save();

            logger.info(`Job ${jobName} completed successfully`);
        } catch (error) {
            // Log error
            logger.error(`Error in job ${jobName}: ${error.message}`);

            cronJobLog.status = 'failed';
            cronJobLog.error = error.message;
            cronJobLog.completedAt = new Date();
            await cronJobLog.save();
        } finally {
            // Release job lock
            activeJobs.set(jobName, false);
        }
    }, {
        scheduled: true,
        timezone: process.env.TIMEZONE || 'UTC',
    });

    logger.info('Server checks scheduled to run every minute');
    return job;
};

/**
 * Schedule data retention job (cleanup old data)
 */
const scheduleDataRetention = () => {
    // Run at midnight every day
    const job = cron.schedule('0 0 * * *', async () => {
        const jobName = 'data-retention';

        // Don't run if already running
        if (activeJobs.get(jobName)) {
            logger.warn(`Job ${jobName} is already running, skipping this execution`);
            return;
        }

        // Set job as active
        activeJobs.set(jobName, true);

        // Log start in database
        const cronJobLog = new CronJob({
            name: jobName,
            status: 'running',
            startedAt: new Date(),
        });

        await cronJobLog.save();

        try {
            logger.info(`Running job: ${jobName}`);

            // Import dynamically to avoid circular dependencies
            const { runDataRetention } = await import('./dataRetention.js');

            // Execute the job
            const result = await runDataRetention();

            // Log completion
            cronJobLog.status = 'completed';
            cronJobLog.completedAt = new Date();
            cronJobLog.result = result;
            await cronJobLog.save();

            logger.info(`Job ${jobName} completed successfully`);
        } catch (error) {
            // Log error
            logger.error(`Error in job ${jobName}: ${error.message}`);

            cronJobLog.status = 'failed';
            cronJobLog.error = error.message;
            cronJobLog.completedAt = new Date();
            await cronJobLog.save();
        } finally {
            // Release job lock
            activeJobs.set(jobName, false);
        }
    }, {
        scheduled: true,
        timezone: process.env.TIMEZONE || 'UTC',
    });

    logger.info('Data retention job scheduled to run at midnight daily');
    return job;
};

/**
 * Schedule daily reports generation
 */
const scheduleDailyReports = () => {
    // Run at 1 AM every day
    const job = cron.schedule('0 1 * * *', async () => {
        const jobName = 'daily-reports';

        // Don't run if already running
        if (activeJobs.get(jobName)) {
            logger.warn(`Job ${jobName} is already running, skipping this execution`);
            return;
        }

        // Set job as active
        activeJobs.set(jobName, true);

        // Log start in database
        const cronJobLog = new CronJob({
            name: jobName,
            status: 'running',
            startedAt: new Date(),
        });

        await cronJobLog.save();

        try {
            logger.info(`Running job: ${jobName}`);

            // Import dynamically to avoid circular dependencies
            const { generateDailyReports } = await import('./generateReports.js');

            // Execute the job
            const result = await generateDailyReports();

            // Log completion
            cronJobLog.status = 'completed';
            cronJobLog.completedAt = new Date();
            cronJobLog.result = result;
            await cronJobLog.save();

            logger.info(`Job ${jobName} completed successfully`);
        } catch (error) {
            // Log error
            logger.error(`Error in job ${jobName}: ${error.message}`);

            cronJobLog.status = 'failed';
            cronJobLog.error = error.message;
            cronJobLog.completedAt = new Date();
            await cronJobLog.save();
        } finally {
            // Release job lock
            activeJobs.set(jobName, false);
        }
    }, {
        scheduled: true,
        timezone: process.env.TIMEZONE || 'UTC',
    });

    logger.info('Daily reports job scheduled to run at 1 AM daily');
    return job;
};

// Graceful shutdown
process.on('SIGINT', async () => {
    logger.info('SIGINT received. Shutting down cron jobs gracefully');
    cron.getTasks().forEach(task => task.stop());
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('SIGTERM received. Shutting down cron jobs gracefully');
    cron.getTasks().forEach(task => task.stop());
    process.exit(0);
});

// If this file is run directly (not imported), initialize cron jobs
if (import.meta.url === `file://${process.argv[1]}`) {
    initCronJobs();
}

export default { initCronJobs };