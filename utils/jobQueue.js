// utils/jobQueue.js
import logger from './logger.js';

class JobQueue {
    constructor() {
        this.jobs = new Map();
        this.running = new Map();
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

    // Execute a job
    async execute(name) {

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
}

// Create a singleton instance
const jobQueueInstance = new JobQueue();

export default jobQueueInstance;