// tasks/index.js
import cron from 'node-cron';
import logger from '../utils/logger.js';
import { cleanupOldData } from './dataRetention.js';
import { checkAllServers } from './checkServers.js';
import { generateDailyReports } from './generateReports.js';
import jobQueue from '../utils/jobQueue.js';

/**
 * Initialize cron jobs
 */
export const initCronJobs = async () => {
    try {
        logger.info('Initializing cron jobs');

        // Initialize queue with all jobs
        jobQueue.add('checkServers', checkAllServers, 1);
        jobQueue.add('dataRetention', cleanupOldData, 2);
        jobQueue.add('generateReports', generateDailyReports, 2);

        // Server check job - run every minute
        cron.schedule('* * * * *', async () => {
            const jobName = 'checkServers';

            try {
                const result = await jobQueue.execute(jobName);

                if (result === false) {
                    logger.info(`Job ${jobName} is already running, skipping this execution`);
                } else {
                    logger.info(`Job ${jobName} completed successfully`, { result });
                }
            } catch (error) {
                logger.error(`Error in job ${jobName}: ${error.message}`);
            }
        });

        // Data retention job - run at midnight
        cron.schedule('0 0 * * *', async () => {
            const jobName = 'dataRetention';

            try {
                const result = await jobQueue.execute(jobName);

                if (result === false) {
                    logger.info(`Job ${jobName} is already running, skipping this execution`);
                } else {
                    logger.info(`Job ${jobName} completed successfully`, { result });
                }
            } catch (error) {
                logger.error(`Error in job ${jobName}: ${error.message}`);
            }
        });

        // Daily reports job - run at 1 AM
        cron.schedule('0 1 * * *', async () => {
            const jobName = 'generateReports';

            try {
                const result = await jobQueue.execute(jobName);

                if (result === false) {
                    logger.info(`Job ${jobName} is already running, skipping this execution`);
                } else {
                    logger.info(`Job ${jobName} completed successfully`, { result });
                }
            } catch (error) {
                logger.error(`Error in job ${jobName}: ${error.message}`);
            }
        });

        logger.info('All cron jobs initialized successfully');
    } catch (error) {
        logger.error(`Error initializing cron jobs: ${error.message}`);
    }
};

export default { initCronJobs };