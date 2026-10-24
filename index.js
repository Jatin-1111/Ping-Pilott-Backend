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
import { apiLimiter } from './middleware/rateLimiter.js';

// Import routes
import authRoutes from './routes/authRoutes.js';
import serverRoutes from './routes/serverRoutes.js';
import userRoutes from './routes/userRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import adminAnalyticsRoutes from './routes/adminAnalyticsRoutes.js';
import supportRoutes from './routes/supportRoutes.js';

import { initCronJobs } from './tasks/index.js';

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 5000;

// Create HTTP server for Socket.io
import { createServer } from 'http';
import { initializeSocket, broadcastServerUpdate } from './config/socket.js';
import { Redis } from 'ioredis';
import mongoose from 'mongoose';
import { redisConnection } from './config/redis.js';

const httpServer = createServer(app);
const io = initializeSocket(httpServer);

// Connect to MongoDB
connectDB();

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
        Promise.resolve().then(() => mongoose.connection.db.admin().ping()),

        // Redis check
        redisConnection.ping(),

        // Memory and uptime
        Promise.resolve({
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            cpu: process.cpuUsage()
        })
    ]);

    // Public endpoint (load balancers and uptime checks call it), so it says only whether things are up.
    // Memory use, uptime and the environment name are not for strangers.
    const health = {
        status: checks.slice(0, 2).every(c => c.status === 'fulfilled') ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        checks: {
            mongodb: checks[0].status === 'fulfilled' ? 'up' : 'down',
            redis: checks[1].status === 'fulfilled' ? 'up' : 'down'
        }
    };

    res.status(health.status === 'healthy' ? 200 : 503).json(health);
});

// API routes
// Flood protection for everything under /api (auth routes add stricter limits of their own)
app.use('/api', apiLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/servers', serverRoutes);
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

redisSubscriber.subscribe('monitor-updates', (err, count) => {
    if (err) {
        logger.error('Failed to subscribe to monitor-updates channel: %s', err.message);
    } else {
        logger.info(`📢 Subscribed to monitor-updates channel. Count: ${count}`);
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