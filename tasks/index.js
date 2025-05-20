// tasks/index.js - Updated with timestamp fix

import cron from 'node-cron';
import logger from '../utils/logger.js';
import dataRetentionService from './dataRetention.js';
import checkServersService from './checkServers.js';
import jobQueue from '../utils/jobQueue.js';
import CronJob from '../models/CronJob.js';

import moment from 'moment-timezone';

/**
 * Initialize cron jobs
 */
export const initCronJobs = async () => {
    try {
        logger.info('Initializing cron jobs');
        console.log('[TROUBLESHOOTING] Initializing cron jobs');

        // Force timezone to UTC for consistency
        process.env.TZ = 'UTC';
        // Also set moment's default timezone
        moment.tz.setDefault('UTC');

        // Log actual current time for verification
        const currentTime = new Date();
        const currentMoment = moment();
        console.log(`[TIMESTAMP] Current system time: ${currentTime.toISOString()}`);
        console.log(`[TIMESTAMP] Current moment time: ${currentMoment.format()}`);
        console.log(`[TIMESTAMP] Current timestamp: ${Date.now()}`);

        // Initialize queue with all jobs
        jobQueue.add('checkServers', checkServersService.checkAllServers, 1);
        jobQueue.add('dataRetention', dataRetentionService.runDataRetention, 2);

        // Log existing cron jobs in database for troubleshooting
        try {
            const recentJobs = await CronJob.find().sort({ startedAt: -1 }).limit(5);
            if (recentJobs.length > 0) {
                logger.info(`Found ${recentJobs.length} recent job records in database`);
                console.log(`[TROUBLESHOOTING] Found ${recentJobs.length} recent job records in database`);

                // Check for timestamp discrepancies
                recentJobs.forEach(job => {
                    const jobTime = new Date(job.startedAt);
                    const timeDiff = Math.abs(currentTime - jobTime) / (1000 * 60 * 60 * 24); // diff in days

                    logger.info(`Job: ${job.name}, Status: ${job.status}, Started: ${job.startedAt}`);
                    console.log(`[TIMESTAMP] Job: ${job.name}, Date: ${job.startedAt}, Time diff from now: ${timeDiff.toFixed(2)} days`);

                    if (timeDiff > 1) {
                        console.log(`[WARNING] Job timestamp differs from current time by ${timeDiff.toFixed(2)} days!`);
                    }
                });
            } else {
                logger.info('No recent job records found in database');
                console.log('[TROUBLESHOOTING] No recent job records found in database');
            }
        } catch (dbError) {
            logger.error(`Error checking recent jobs: ${dbError.message}`);
            console.error(`[TROUBLESHOOTING] Error checking recent jobs: ${dbError.message}`);
        }

        // Server check job - run every minute with timestamp verification
        cron.schedule('* * * * *', async () => {
            const actualStartTime = new Date();
            const jobName = 'checkServers';
            const defaultTimezone = 'Asia/Kolkata';

            // Verify time is correct before creating the record
            console.log(`[TIMESTAMP] Starting ${jobName} at actual time: ${actualStartTime.toISOString()}`);

            // Create job record with explicitly created Date object for timestamps
            const cronJobRecord = new CronJob({
                name: jobName,
                status: 'running',
                startedAt: new Date(), // Explicitly create new Date to avoid any date string parsing issues
                timezone: defaultTimezone
            });

            // Log job start
            const startTimeLocal = moment().tz(defaultTimezone).format();
            logger.info(`Starting job ${jobName} at ${startTimeLocal} (${defaultTimezone})`);

            try {
                // Save job start record to database
                await cronJobRecord.save();

                // Verify the saved timestamp
                const savedJob = await CronJob.findById(cronJobRecord._id);
                console.log(`[TIMESTAMP] Saved job start time: ${savedJob.startedAt}`);

                // Check for time discrepancy
                const timeDiffMs = Math.abs(new Date(savedJob.startedAt) - actualStartTime);
                if (timeDiffMs > 5000) { // More than 5 seconds difference
                    console.log(`[WARNING] Timestamp discrepancy detected: ${timeDiffMs}ms difference!`);
                }

                const result = await jobQueue.execute(jobName);

                if (result === false) {
                    logger.info(`Job ${jobName} is already running, skipping this execution`);
                    cronJobRecord.status = 'skipped';
                } else {
                    logger.info(`Job ${jobName} completed successfully`, { result });
                    cronJobRecord.status = 'completed';
                    cronJobRecord.result = result;
                }
            } catch (error) {
                logger.error(`Error in job ${jobName}: ${error.message}`);
                console.error(`[TROUBLESHOOTING] Error in job ${jobName}: ${error.message}`);
                cronJobRecord.status = 'failed';
                cronJobRecord.error = error.message;
            } finally {
                // Update job completion time - explicitly use new Date()
                cronJobRecord.completedAt = new Date();
                try {
                    await cronJobRecord.save();

                    // Verify the completion timestamp
                    const completedTime = new Date();
                    const updatedJob = await CronJob.findById(cronJobRecord._id);
                    console.log(`[TIMESTAMP] Saved job completion time: ${updatedJob.completedAt}`);

                    // Check for time discrepancy
                    const completedTimeDiffMs = Math.abs(new Date(updatedJob.completedAt) - completedTime);
                    if (completedTimeDiffMs > 5000) {
                        console.log(`[WARNING] Completion timestamp discrepancy detected: ${completedTimeDiffMs}ms difference!`);
                    }

                } catch (dbError) {
                    logger.error(`Error saving cron job record: ${dbError.message}`);
                    console.error(`[TROUBLESHOOTING] Error saving cron job record: ${dbError.message}`);
                }
            }
        });

        // Modify the data retention job similarly
        cron.schedule('0 0 * * *', async () => {
            const actualStartTime = new Date();
            const jobName = 'dataRetention';

            console.log(`[TIMESTAMP] Starting ${jobName} at actual time: ${actualStartTime.toISOString()}`);

            const cronJobRecord = new CronJob({
                name: jobName,
                status: 'running',
                startedAt: new Date()
            });

            // Log job start
            logger.info(`Starting job ${jobName} at ${actualStartTime.toISOString()}`);

            try {
                await cronJobRecord.save();
                const result = await jobQueue.execute(jobName);

                if (result === false) {
                    logger.info(`Job ${jobName} is already running, skipping this execution`);
                    cronJobRecord.status = 'skipped';
                } else {
                    logger.info(`Job ${jobName} completed successfully`, { result });
                    cronJobRecord.status = 'completed';
                    cronJobRecord.result = result;
                }
            } catch (error) {
                logger.error(`Error in job ${jobName}: ${error.message}`);
                console.error(`[TROUBLESHOOTING] Error in job ${jobName}: ${error.message}`);
                cronJobRecord.status = 'failed';
                cronJobRecord.error = error.message;
            } finally {
                cronJobRecord.completedAt = new Date();
                try {
                    await cronJobRecord.save();
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