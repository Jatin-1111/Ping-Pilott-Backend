// utils/jobQueue.js - FIXED WITH STOP METHOD

import logger from './logger.js';

class JobQueue {
    constructor() {
        this.jobs = new Map();
        this.running = new Map();
        this.stopped = false; // Add stopped flag
        console.log('[TROUBLESHOOTING] JobQueue initialized');
    }

    // Add a job to the queue
    add(name, fn, priority = 1) {
        if (!this.jobs.has(name)) {
            this.jobs.set(name, { fn, priority, lastRun: null });
            logger.info(`Job '${name}' added to queue with priority ${priority}`);
        } else {
            logger.info(`Job '${name}' already exists in queue`);
        }
    }

    // Check if a job is currently running
    isRunning(name) {
        const running = this.running.get(name) === true;
        return running;
    }

    // Get all registered jobs
    getJobs() {
        return Array.from(this.jobs.keys());
    }

    // Get running jobs
    getRunningJobs() {
        return Array.from(this.running.entries())
            .filter(([_, isRunning]) => isRunning)
            .map(([name]) => name);
    }

    // Stop the job queue (prevent new jobs)
    stop() {
        this.stopped = true;
        logger.info('🛑 Job queue stopped - no new jobs will be accepted');
    }

    // Start the job queue (allow new jobs)
    start() {
        this.stopped = false;
        logger.info('🚀 Job queue started - accepting new jobs');
    }

    // Check if queue is stopped
    isStopped() {
        return this.stopped;
    }

    // Execute a job
    async execute(name) {
        // Check if queue is stopped
        if (this.stopped) {
            logger.warn(`Job '${name}' rejected - queue is stopped`);
            return false;
        }

        if (!this.jobs.has(name)) {
            logger.warn(`Job '${name}' not found in queue`);
            return false;
        }

        if (this.isRunning(name)) {
            logger.info(`Job '${name}' is already running, skipping execution`);
            return false;
        }

        this.running.set(name, true);
        const job = this.jobs.get(name);
        const startTime = Date.now();

        logger.info(`Executing job '${name}'`);

        try {
            const result = await job.fn();
            const execTime = Date.now() - startTime;

            job.lastRun = new Date();
            logger.info(`Job '${name}' completed in ${execTime}ms`);

            return result;
        } catch (error) {
            const execTime = Date.now() - startTime;

            logger.error(`Error executing job '${name}' (${execTime}ms): ${error.message}`);
            console.error(`[TROUBLESHOOTING] Error executing job '${name}' (${execTime}ms): ${error.message}`);

            throw error;
        } finally {
            this.running.set(name, false);
        }
    }

    // Clear all jobs (for cleanup)
    clear() {
        this.jobs.clear();
        this.running.clear();
        logger.info('🧹 Job queue cleared');
    }

    // Get queue status
    getStatus() {
        return {
            totalJobs: this.jobs.size,
            runningJobs: this.getRunningJobs().length,
            stopped: this.stopped,
            jobs: Array.from(this.jobs.keys())
        };
    }
}

// Create a singleton instance
const jobQueueInstance = new JobQueue();

export default jobQueueInstance;