// utils/jobQueue.js
class JobQueue {
    constructor() {
        this.jobs = new Map();
        this.running = new Map();
    }

    // Add a job to the queue
    add(name, fn, priority = 1) {
        if (!this.jobs.has(name)) {
            this.jobs.set(name, { fn, priority, lastRun: null });
        }
    }

    // Check if a job is currently running
    isRunning(name) {
        return this.running.get(name) === true;
    }

    // Execute a job
    async execute(name) {
        if (this.isRunning(name) || !this.jobs.has(name)) {
            return false;
        }

        this.running.set(name, true);
        const job = this.jobs.get(name);

        try {
            const result = await job.fn();
            job.lastRun = new Date();
            return result;
        } catch (error) {
            logger.error(`Error executing job ${name}: ${error.message}`);
            throw error;
        } finally {
            this.running.set(name, false);
        }
    }
}

export default new JobQueue();