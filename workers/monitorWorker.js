import './loadEnv.js';
import { Worker } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import { runCheck } from '../services/checkRunner.js';
import Server from '../models/Server.js';
import ServerCheck from '../models/ServerCheck.js';
import { applyCheckResult } from '../services/checkRecorder.js';
import logger from '../utils/logger.js';
import { throttled, suppressedNote } from '../utils/logThrottle.js';
import { startWorkerHeartbeat, createCheckCompletionRecorder } from '../utils/workerHealth.js';
import { egressProbe } from '../services/egressProbe.js';
import { describeThreadPool } from '../utils/threadPool.js';
import { cleanTimings } from '../utils/timings.js';
import { loadMonitor, formatSummary, loopLagLimitMs } from '../services/loadMonitor.js';
import { performance } from 'perf_hooks';
import { EGRESS_DOWN_KEY } from '../utils/healthKeys.js';
import mongoose from 'mongoose';

const QUEUE_NAME = 'monitor-server-queue';

const markCheckCompleted = createCheckCompletionRecorder({ redis: redisConnection });

// A check job that has waited this long is out of date: the next scheduled check has already taken its place.
// Skipping them matters after the workers have been down for a while, when thousands of old jobs are waiting and
// running them all would hit the monitored sites in one burst and fill the history with checks stamped "now".
const STALE_JOB_MS = 10 * 60 * 1000;

// Check history is written in batches (it is append-only, so a late write is harmless).
// The server's own status is NOT batched: it must be written atomically, see below.
const checkBatch = [];
let batchTimer = null;
const BATCH_SIZE = 100;
const BATCH_TIMEOUT = 5000;

async function executeBatch() {
    if (checkBatch.length === 0) return;

    const docs = checkBatch.splice(0, checkBatch.length);
    try {
        await ServerCheck.insertMany(docs, { ordered: false });
    } catch (error) {
        logger.error(`Check history batch failed (${docs.length} checks): ${error.message}`);
    }
}

async function addToBatch(checkDoc) {
    checkBatch.push(checkDoc);
    clearTimeout(batchTimer);

    if (checkBatch.length >= BATCH_SIZE) {
        await executeBatch();
    } else {
        batchTimer = setTimeout(executeBatch, BATCH_TIMEOUT);
    }
}

export const monitorWorker = new Worker(QUEUE_NAME, async (job) => {
    const { serverId } = job.data;
    const startTime = Date.now();
    const startedAtMonotonic = performance.now();

    // scheduledFor is the scheduler tick; jobs queued by older versions only have the time they were added
    const queuedAt = job.data.scheduledFor || job.timestamp;
    if (queuedAt && startTime - queuedAt > STALE_JOB_MS) {
        // One summary line a minute instead of a debug line each: how many checks were skipped says how far behind the
        // workers are, and after an outage there can be thousands
        throttled('stale-check-jobs', 60 * 1000, (n) => {
            logger.warn(`Skipping stale check jobs (queued over ${STALE_JOB_MS / 60000} minutes ago; ${n + 1} in the last minute, the latest was queued ${Math.round((startTime - queuedAt) / 60000)} min ago)`);
        });
        return;
    }

    try {
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGO_URI);
        }

        const server = await Server.findById(serverId)
            .select('name url type timezone monitoring status lastChecked uploadedBy contactEmails contactPhones priority slowAlerted slowStreak fastStreak')
            .lean();

        if (!server) {
            logger.warn(`Server ${serverId} not found, skipping check`);
            return;
        }

        // A first failure is confirmed before it is acted on (see services/checkRunner.js)
        const checkResult = await runCheck(server);

        const { now } = await applyCheckResult(server, checkResult, { checkType: 'automated' });
        const timings = cleanTimings(checkResult.timings); // null (and not stored) for a failed check

        await addToBatch({
            serverId: new mongoose.Types.ObjectId(serverId),
            status: checkResult.status,
            responseTime: checkResult.responseTime,
            error: checkResult.error,
            ...(timings && { timings }),
            ...(checkResult.loadSuspect && { loadSuspect: true }),
            timestamp: now,
            checkType: 'automated'
        });

        loadMonitor.recordCheck(checkResult);
        if (checkResult.loadSuspect) {
            // The time says more about this worker than about the server, so it did not count toward a slow alert
            throttled('slow-sample-set-aside', 60 * 1000, (n) => {
                logger.warn(`A slow check was set aside because this worker's event loop was stalled (${loadMonitor.lagSince(startedAtMonotonic)} ms late). It is running more checks than it keeps up with: add worker instances or lower MONITOR_CONCURRENCY${suppressedNote(n, 60 * 1000)}`);
            });
        }

        // /health uses this to tell "checks are being queued" from "checks are being done"
        markCheckCompleted();

        logger.debug(`Job ${job.id} (Check ${server.name}) processed in ${Date.now() - startTime}ms`);

    } catch (error) {
        // Our own network is down (services/egressProbe.js): nothing was recorded, and retrying now would only fail
        // again. The server keeps its slot in the schedule and is checked at its next one.
        if (error.code === 'EGRESS_DOWN') {
            throttled('egress-down-skip', 60 * 1000, (n) => {
                logger.error(`Check skipped because this machine cannot reach the internet${suppressedNote(n, 60 * 1000)}`);
            });
            return;
        }
        logger.error(`Worker failed for job ${job.id}: ${error.message}`);
        throw error;
    }
}, {
    connection: redisConnection,
    // Checks wait on the network, not the CPU, and a failing one can hold its slot for 30 s, so a worker can be
    // given more. Set MONITOR_CONCURRENCY (the rate limit below still applies).
    concurrency: Math.max(1, parseInt(process.env.MONITOR_CONCURRENCY, 10) || 50),
    limiter: {
        max: 100,
        duration: 1000
    }
});

monitorWorker.on('completed', () => { });

monitorWorker.on('failed', (job, err) => {
    logger.error(`Job ${job?.id} has failed with ${err.message}`);
});

monitorWorker.on('error', (err) => {
    throttled('monitor-worker-error', 30 * 1000, (n) => {
        logger.error(`Monitor worker error${suppressedNote(n, 30 * 1000)}:`, err);
    });
});

// While the control targets cannot be reached, say so for /health/monitoring (the key expires two minutes after the last failed probe)
egressProbe.setReporter((up) => {
    if (!up) redisConnection.set(EGRESS_DOWN_KEY, String(Date.now()), 'EX', 120).catch(() => {});
});

// Say "alive" every 15 s for /health and the container healthcheck; the key expires if this process stops
const heartbeat = startWorkerHeartbeat({ redis: redisConnection, role: 'monitor', isRunning: () => monitorWorker.isRunning() });

// Watch this process's own event loop, so a slow check measured during a stall can be set aside (services/loadMonitor.js),
// and say once a minute how DNS and the loop are doing
loadMonitor.start();
const summaryTimer = setInterval(() => {
    const line = formatSummary(loadMonitor.summarize());
    if (line) logger.info(line);
}, 60 * 1000);
summaryTimer.unref?.();

monitorWorker.on('closing', async () => {
    heartbeat.stop();
    clearInterval(summaryTimer);
    loadMonitor.stop();
    logger.info('Worker closing, writing remaining check history...');
    clearTimeout(batchTimer);
    await executeBatch();
});

// Flush buffered history and stop taking jobs when the process is asked to stop
const shutdown = async (signal) => {
    logger.info(`${signal} received, closing monitor worker...`);
    try {
        await monitorWorker.close();
    } finally {
        process.exit(0);
    }
};
// As its own process this worker handles shutdown. Embedded in the API process (see index.js) the API does,
// and closes the worker itself, so two handlers do not race to exit.
if (!process.env.PP_WORKERS_EMBEDDED) {
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

logger.info(`🚀 Monitor Worker started - listening on queue: ${QUEUE_NAME}`);

// Checks resolve hostnames on libuv's thread pool; say whether it is big enough (see utils/threadPool.js)
const threadPool = describeThreadPool();
if (threadPool.ok) logger.info(threadPool.message);
else logger.warn(threadPool.message);

const lagLimit = loopLagLimitMs();
logger.info(lagLimit > 0
    ? `Slow checks measured while the event loop is more than ${lagLimit} ms late are set aside (LOOP_LAG_SUSPECT_MS)`
    : 'Event-loop guard is off (LOOP_LAG_SUSPECT_MS=0)');
