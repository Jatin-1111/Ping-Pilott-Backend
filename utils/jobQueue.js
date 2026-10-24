// utils/jobQueue.js - runs named jobs one at a time each, with a time limit
//
// A job that never finishes used to keep its "running" flag set forever, so every later run was skipped with
// "already running" and nothing was dispatched until the process restarted. Jobs can now be given a timeout:
// when it passes, the run is abandoned, the flag is released and the next cycle goes ahead.

import logger from './logger.js';
import { withTimeout, TimeoutError } from './timeout.js';

export class JobQueue {
    constructor() {
        this.jobs = new Map();
        // name -> { token, startedAt } while a run is in progress. The token lets a run that was given up on
        // finish later without releasing the lock of the run that replaced it.
        this.running = new Map();
        this.stopped = false;
    }

    /**
     * Add a job to the queue
     * @param {string} name
     * @param {Function} fn
     * @param {number} priority
     * @param {{ timeoutMs?: number }} options  timeoutMs: give up on a run after this long (no limit when omitted)
     */
    add(name, fn, priority = 1, options = {}) {
        if (!this.jobs.has(name)) {
            this.jobs.set(name, { fn, priority, lastRun: null, timeoutMs: options.timeoutMs || null });
            logger.info(`Job '${name}' added to queue with priority ${priority}`);
        } else {
            logger.info(`Job '${name}' already exists in queue`);
        }
    }

    // Check if a job is currently running
    isRunning(name) {
        return this.running.has(name);
    }

    // Get all registered jobs
    getJobs() {
        return Array.from(this.jobs.keys());
    }

    // Get running jobs
    getRunningJobs() {
        return Array.from(this.running.keys());
    }

    /** When the job last finished successfully, or null */
    lastRunOf(name) {
        return this.jobs.get(name)?.lastRun ?? null;
    }

    /** How long the current run has been going, in ms, or null when it isn't running */
    runningForMs(name, now = Date.now()) {
        const run = this.running.get(name);
        return run ? now - run.startedAt : null;
    }

    /**
     * Release a job's lock by hand, so the next execute() isn't skipped. The abandoned run keeps going in the
     * background (it can't be cancelled) but can no longer block the job. Returns true if it was running.
     */
    forceRelease(name) {
        return this.running.delete(name);
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
        if (this.stopped) {
            logger.warn(`Job '${name}' rejected - queue is stopped`);
            return false;
        }

        const job = this.jobs.get(name);
        if (!job) {
            logger.warn(`Job '${name}' not found in queue`);
            return false;
        }

        if (this.isRunning(name)) {
            logger.info(`Job '${name}' is already running (${Math.round(this.runningForMs(name) / 1000)}s), skipping execution`);
            return false;
        }

        const token = Symbol(name);
        const startTime = Date.now();
        this.running.set(name, { token, startedAt: startTime });

        logger.info(`Executing job '${name}'`);

        try {
            const work = Promise.resolve().then(() => job.fn());
            const result = job.timeoutMs ? await withTimeout(work, job.timeoutMs, `Job '${name}'`) : await work;

            job.lastRun = new Date();
            logger.info(`Job '${name}' completed in ${Date.now() - startTime}ms`);

            return result;
        } catch (error) {
            const execTime = Date.now() - startTime;
            if (error instanceof TimeoutError) {
                logger.error(`Job '${name}' gave up after ${execTime}ms and was released so the next run can start`);
            } else {
                logger.error(`Error executing job '${name}' (${execTime}ms): ${error.message}`);
            }
            throw error;
        } finally {
            // Only release our own lock: after a timeout or forceRelease a newer run may hold it
            if (this.running.get(name)?.token === token) this.running.delete(name);
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
