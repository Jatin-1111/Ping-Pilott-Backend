// tasks/index.js
import cron from 'node-cron';
import logger from '../utils/logger.js';
import dataRetentionService from './dataRetention.js';
import checkServersService from './checkServers.js';
import jobQueue from '../utils/jobQueue.js';
import CronJob from '../models/CronJob.js';

/**
 * Initialize cron jobs
 */
export const initCronJobs = async () => {
    try {
        logger.info('Initializing cron jobs');
        console.log('[TROUBLESHOOTING] Initializing cron jobs');

        // Initialize queue with all jobs
        jobQueue.add('checkServers', checkServersService.checkAllServers, 1);
        jobQueue.add('dataRetention', dataRetentionService.runDataRetention, 2);

        // Log existing cron jobs in database for troubleshooting
        try {
            const recentJobs = await CronJob.find().sort({ startedAt: -1 }).limit(5);
            if (recentJobs.length > 0) {
                logger.info(`Found ${recentJobs.length} recent job records in database`);
                console.log(`[TROUBLESHOOTING] Found ${recentJobs.length} recent job records in database`);
                recentJobs.forEach(job => {
                    logger.info(`Job: ${job.name}, Status: ${job.status}, Started: ${job.startedAt}`);
                    console.log(`[TROUBLESHOOTING] Job: ${job.name}, Status: ${job.status}, Started: ${job.startedAt}`);
                });
            } else {
                logger.info('No recent job records found in database');
                console.log('[TROUBLESHOOTING] No recent job records found in database');
            }
        } catch (dbError) {
            logger.error(`Error checking recent jobs: ${dbError.message}`);
            console.error(`[TROUBLESHOOTING] Error checking recent jobs: ${dbError.message}`);
        }

        // Server check job - run every minute
        cron.schedule('* * * * *', async () => {
            const jobName = 'checkServers';
            const cronJobRecord = new CronJob({
                name: jobName,
                status: 'running',
                startedAt: new Date()
            });

            // Log job start
            logger.info(`Starting job ${jobName} at ${new Date().toISOString()}`);
            console.log(`[TROUBLESHOOTING] Starting job ${jobName} at ${new Date().toISOString()}`);

            try {
                // Save job start record to database
                await cronJobRecord.save();
                console.log(`[TROUBLESHOOTING] Job record created in database with ID: ${cronJobRecord._id}`);

                const result = await jobQueue.execute(jobName);

                if (result === false) {
                    logger.info(`Job ${jobName} is already running, skipping this execution`);
                    console.log(`[TROUBLESHOOTING] Job ${jobName} is already running, skipping this execution`);
                    cronJobRecord.status = 'skipped';
                } else {
                    logger.info(`Job ${jobName} completed successfully`, { result });
                    console.log(`[TROUBLESHOOTING] Job ${jobName} completed successfully:`, JSON.stringify(result));
                    cronJobRecord.status = 'completed';
                    cronJobRecord.result = result;
                }
            } catch (error) {
                logger.error(`Error in job ${jobName}: ${error.message}`);
                console.error(`[TROUBLESHOOTING] Error in job ${jobName}: ${error.message}`);
                cronJobRecord.status = 'failed';
                cronJobRecord.error = error.message;
            } finally {
                // Update job completion time
                cronJobRecord.completedAt = new Date();
                try {
                    await cronJobRecord.save();
                    console.log(`[TROUBLESHOOTING] Job record updated in database with status: ${cronJobRecord.status}`);
                } catch (dbError) {
                    logger.error(`Error saving cron job record: ${dbError.message}`);
                    console.error(`[TROUBLESHOOTING] Error saving cron job record: ${dbError.message}`);
                }
            }
        });

        // Data retention job - run at midnight
        cron.schedule('0 0 * * *', async () => {
            const jobName = 'dataRetention';
            const cronJobRecord = new CronJob({
                name: jobName,
                status: 'running',
                startedAt: new Date()
            });

            // Log job start
            logger.info(`Starting job ${jobName} at ${new Date().toISOString()}`);
            console.log(`[TROUBLESHOOTING] Starting job ${jobName} at ${new Date().toISOString()}`);

            try {
                // Save job start record to database
                await cronJobRecord.save();
                console.log(`[TROUBLESHOOTING] Job record created in database with ID: ${cronJobRecord._id}`);

                const result = await jobQueue.execute(jobName);

                if (result === false) {
                    logger.info(`Job ${jobName} is already running, skipping this execution`);
                    console.log(`[TROUBLESHOOTING] Job ${jobName} is already running, skipping this execution`);
                    cronJobRecord.status = 'skipped';
                } else {
                    logger.info(`Job ${jobName} completed successfully`, { result });
                    console.log(`[TROUBLESHOOTING] Job ${jobName} completed successfully:`, JSON.stringify(result));
                    cronJobRecord.status = 'completed';
                    cronJobRecord.result = result;
                }
            } catch (error) {
                logger.error(`Error in job ${jobName}: ${error.message}`);
                console.error(`[TROUBLESHOOTING] Error in job ${jobName}: ${error.message}`);
                cronJobRecord.status = 'failed';
                cronJobRecord.error = error.message;
            } finally {
                // Update job completion time
                cronJobRecord.completedAt = new Date();
                try {
                    await cronJobRecord.save();
                    console.log(`[TROUBLESHOOTING] Job record updated in database with status: ${cronJobRecord.status}`);
                } catch (dbError) {
                    logger.error(`Error saving cron job record: ${dbError.message}`);
                    console.error(`[TROUBLESHOOTING] Error saving cron job record: ${dbError.message}`);
                }
            }
        });

        logger.info('All cron jobs initialized successfully');
        console.log('[TROUBLESHOOTING] All cron jobs initialized successfully');
    } catch (error) {
        logger.error(`Error initializing cron jobs: ${error.message}`);
        console.error(`[TROUBLESHOOTING] Error initializing cron jobs: ${error.message}`);
    }
};

export default { initCronJobs };