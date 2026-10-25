import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import mongoSanitize from 'express-mongo-sanitize';
import morgan from 'morgan';
import { fileURLToPath } from 'url';
import path from 'path';

// Load environment variables
dotenv.config();

// Import modules
import { connectDB } from './config/db.js';
import logger from './utils/logger.js';
import errorMiddleware from './middleware/error.js';
import { performanceMonitoring } from './middleware/performanceMonitoring.js';
import { apiLimiter, installLimiter } from './middleware/rateLimiter.js';

// Import routes
import authRoutes from './routes/authRoutes.js';
import serverRoutes from './routes/serverRoutes.js';
import agentRoutes from './routes/agentRoutes.js';
import installHandler from './routes/installRoute.js';
import userRoutes from './routes/userRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import adminAnalyticsRoutes from './routes/adminAnalyticsRoutes.js';
import supportRoutes from './routes/supportRoutes.js';
import incidentRoutes from './routes/incidentRoutes.js';
import alertRoutes from './routes/alertRoutes.js';
import appRoutes from './routes/appRoutes.js';
import statusPageRoutes, { publicStatusRouter } from './routes/statusPageRoutes.js';

import { initCronJobs, getSchedulerStatus, getPipelineState } from './tasks/index.js';
import { withTimeout } from './utils/timeout.js';
import { inspectRetention } from './services/retentionCheck.js';
import { resolveRetentionDays } from './utils/retention.js';

const HEALTH_PROBE_TIMEOUT_MS = 2000;

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 5000;

// Create HTTP server for Socket.io
import { createServer } from 'http';
import { initializeSocket, broadcastServerUpdate, broadcastAlert } from './config/socket.js';
import { ALERT_CHANNEL } from './utils/alertFeed.js';
import { Redis } from 'ioredis';
import mongoose from 'mongoose';
import { redisConnection } from './config/redis.js';
import { reconcileOpenIncidents } from './services/incidentService.js';

const httpServer = createServer(app);
// Render's proxy keeps connections open for about a minute. Node closes idle ones after 5 seconds by default, which
// shows up as random failed or slow requests when the proxy reuses a connection Node just dropped.
httpServer.keepAliveTimeout = 65 * 1000;
httpServer.headersTimeout = 66 * 1000;
const io = initializeSocket(httpServer);

// Connect to MongoDB
// The scheduler below only puts check jobs on a queue; something has to take them off and run them, and send the
// alerts. In Docker and PM2 those are separate processes (docker-compose.yml, ecosystem.config.cjs set
// RUN_WORKERS=false for the API). On a single-process host such as Render's free tier there is no other process,
// so by default the API runs both workers itself. Without them servers were queued every minute and never checked.
let inProcessWorkers = [];
const startWorkers = async () => {
    if (process.env.RUN_WORKERS === 'false') return;
    try {
        process.env.PP_WORKERS_EMBEDDED = '1'; // the workers must not install their own shutdown handlers
        const [{ monitorWorker }, { default: alertWorker }] = await Promise.all([
            import('./workers/monitorWorker.js'),
            import('./workers/alertWorker.js')
        ]);
        inProcessWorkers = [monitorWorker, alertWorker];
        logger.info('Monitor and alert workers are running inside the API process');
    } catch (err) {
        logger.error(`Could not start the in-process workers: ${err.message}`);
    }
};

connectDB().then(() => {
    reconcileOpenIncidents();
    startWorkers();
    logRetentionState();
});

// One read-only look at whether old checks are really being removed (services/retentionCheck.js). Never stops start-up.
function logRetentionState() {
    inspectRetention({ db: mongoose.connection.db, retentionDays: resolveRetentionDays(process.env.CHECK_DATA_RETENTION_DAYS).days })
        .then((report) => {
            if (report.warnings.length === 0) {
                logger.info(`Retention check: ${report.exists ? `oldest check ${report.facts.oldestAgeDays ?? 'none'} days old, TTL ${report.facts.ttlDays ?? 'none'} days, keeping ${report.facts.retentionDays}` : 'no checks saved yet'}`);
            } else {
                report.warnings.forEach((warning) => logger.warn(`Retention check: ${warning}`));
            }
        })
        .catch((err) => logger.warn(`Retention check could not run: ${err.message}`));
}

// Behind nginx (docker-compose) every request arrives from the proxy's address. Trusting one proxy hop
// makes req.ip the real client, which the rate limiters depend on. Set TRUST_PROXY=0 when not behind a proxy.
app.set('trust proxy', parseInt(process.env.TRUST_PROXY ?? '1', 10));

// Middleware
// Only our own frontends may call the API from a browser. Requests with no Origin (curl, server-to-server,
// the health check) are not browser requests and are allowed. Add more with CORS_ORIGINS (comma separated).
const allowedOrigins = [process.env.CLIENT_URL, process.env.FRONTEND_URL, ...(process.env.CORS_ORIGINS || '').split(',')]
    .map((o) => (o || '').trim().replace(/\/$/, ''))
    .filter(Boolean);
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(null, false);
    },
    credentials: true
}));
app.use(helmet());
app.use(compression({
    level: 6,              // Balance between speed and compression
    threshold: 1024,       // Only compress responses > 1KB
    filter: (req, res) => {
        if (req.headers['x-no-compression']) {
            return false;
        }
        return compression.filter(req, res);
    }
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(mongoSanitize());

// Logging in development mode
if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
}

// Performance monitoring for all requests
app.use(performanceMonitoring);

// Health check endpoint with system metrics
app.get('/health', async (req, res) => {
    const checks = await Promise.allSettled([
        // MongoDB check
        // wrapped so a ping before Mongo has connected is a failed check, not a crash
        withTimeout(Promise.resolve().then(() => mongoose.connection.db.admin().ping()), HEALTH_PROBE_TIMEOUT_MS, 'Mongo ping'),

        // Redis check. Its commands wait for ever while the connection is down, so without a limit /health hung
        // instead of answering 503.
        withTimeout(redisConnection.ping(), HEALTH_PROBE_TIMEOUT_MS, 'Redis ping'),

        // Memory and uptime
        Promise.resolve({
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            cpu: process.cpuUsage()
        })
    ]);

    // Public endpoint (load balancers and uptime checks call it), so it says only whether things are up.
    // Memory use, uptime and the environment name are not for strangers.
    // A scheduler that has stopped finishing cycles means nobody is being monitored, even with the database and Redis
    // up, so that counts as degraded too. 'starting' (just booted) is not a problem.
    const scheduler = getSchedulerStatus();
    // Whether the workers are alive and finishing checks. Shown here, but it does not change the status code: a worker
    // outage must not make a load balancer take the API (and its dashboards) out of rotation. /health/monitoring is
    // the one that answers 503 for it.
    const pipeline = await getPipelineState();
    const health = {
        status: checks.slice(0, 2).every(c => c.status === 'fulfilled') && scheduler !== 'stalled' ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        checks: {
            mongodb: checks[0].status === 'fulfilled' ? 'up' : 'down',
            redis: checks[1].status === 'fulfilled' ? 'up' : 'down',
            scheduler,
            monitoring: pipeline.state
        }
    };

    res.status(health.status === 'healthy' ? 200 : 503).json(health);
});

// Is monitoring really happening? 200 when the scheduler is running, a monitor worker and an alert worker are alive,
// and queued checks are being finished; 503 otherwise. Point an outside uptime monitor at this one.
// Public, so it says what is wrong in words but gives no counts or addresses; the details are in the log.
let lastPipelineState = 'ok';
app.get('/health/monitoring', async (req, res) => {
    const { state, reasons } = await getPipelineState();
    if (state !== lastPipelineState) {
        // Said once per change, with the reasons, so the log shows when and why monitoring stopped
        const message = `Monitoring pipeline is ${state}${reasons.length ? `: ${reasons.join(', ')}` : ''}`;
        if (state === 'degraded') logger.error(message);
        else logger.info(message);
        lastPipelineState = state;
    }
    res.status(state === 'degraded' ? 503 : 200).json({ status: state, reasons, timestamp: new Date().toISOString() });
});

// API routes
// Host agents sign in with a token and have their own limit per token, so they come before the per-address one
app.use('/api/agent', agentRoutes);
// The script that installs the agent: `curl -fsSL <this address>/install.sh | sudo sh`
app.get('/install.sh', installLimiter, installHandler);

// Flood protection for everything under /api (auth routes add stricter limits of their own)
app.use('/api', apiLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/servers', serverRoutes);
app.use('/api/incidents', incidentRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/app', appRoutes);
app.use('/api/status-pages', statusPageRoutes);
app.use('/api/public', publicStatusRouter);
app.use('/api/users', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/analytics', adminAnalyticsRoutes);
app.use('/api/support', supportRoutes);

// Handle 404 routes
app.use('*', (req, res) => {
    res.status(404).json({
        status: 'error',
        message: `Can't find ${req.originalUrl} on this server`,
    });
});

// Global error handler
app.use(errorMiddleware);

// --- REDIS PUB/SUB FOR REAL-TIME UPDATES ---
// Create a dedicated Redis connection for subscription
const redisSubscriber = new Redis(process.env.REDIS_URL || {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    // No maxRetriesPerRequest null needed here as it's not BullMQ
});

redisSubscriber.subscribe('monitor-updates', ALERT_CHANNEL, (err, count) => {
    if (err) {
        logger.error('Failed to subscribe to the live update channels: %s', err.message);
    } else {
        logger.info(`📢 Subscribed to monitor-updates and ${ALERT_CHANNEL} channels. Count: ${count}`);
    }
});

redisSubscriber.on('message', (channel, message) => {
    if (channel === 'monitor-updates') {
        try {
            const updateData = JSON.parse(message);
            // logger.debug(`Received update for server ${updateData.serverId}`);
            broadcastServerUpdate(updateData);
        } catch (error) {
            logger.error('Error parsing monitor update message:', error);
        }
    } else if (channel === ALERT_CHANNEL) {
        try {
            const { userId, alert } = JSON.parse(message);
            broadcastAlert(userId, alert);
        } catch (error) {
            logger.error('Error parsing alert event message:', error);
        }
    }
});
// -------------------------------------------

// Start server
const server = httpServer.listen(PORT, () => {
    logger.info(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);

    // Initialize cron jobs after server starts
    initCronJobs();
});

// Enhanced graceful shutdown
async function gracefulShutdown(signal) {
    logger.info(`${signal} received. Starting graceful shutdown...`);

    // Stop accepting new requests
    server.close(async () => {
        logger.info('HTTP server closed');

        try {
            // Stop taking check and alert jobs (the monitor worker also writes out its buffered history)
            await Promise.allSettled(inProcessWorkers.map((w) => w.close()));

            // Close Redis connections
            await redisConnection.quit();
            await redisSubscriber.quit();
            logger.info('Redis connections closed');

            // Close MongoDB
            await mongoose.connection.close();
            logger.info('MongoDB connection closed');

            logger.info('Graceful shutdown completed');
            process.exit(0);
        } catch (error) {
            logger.error('Error during shutdown:', error);
            process.exit(1);
        }
    });

    // Force shutdown after 30 seconds
    setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
    }, 30000);
}

// Handle unhandled promise rejections
// A rejected promise nobody handled is a bug to fix, but it is not a reason to drop every user's connection
// (it used to shut the whole API down). Log it loudly and keep serving. A real crash (uncaughtException)
// still shuts down so the process manager can restart a clean process.
process.on('unhandledRejection', (err) => {
    logger.error(`UNHANDLED REJECTION: ${err?.stack || err}`);
});

process.on('uncaughtException', (err) => {
    logger.error(`UNCAUGHT EXCEPTION: ${err?.stack || err}`);
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

// Handle SIGTERM signal
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle SIGINT signal (Ctrl+C)
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;