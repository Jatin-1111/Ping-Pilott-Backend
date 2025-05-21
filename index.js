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

// Connect to MongoDB
connectDB();

// Middleware
app.use(cors());
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(mongoSanitize());

// Logging in development mode
if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'success',
        message: 'Server is healthy',
        timestamp: new Date().toISOString(),
    });
});

// API routes
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

// Start server
const server = app.listen(PORT, () => {
    logger.info(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);

    // Initialize cron jobs after server starts
    initCronJobs();
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
    logger.error('UNHANDLED REJECTION! 💥 Shutting down...');
    logger.error(err.name, err.message);
    server.close(() => {
        process.exit(1);
    });
});

// Handle SIGTERM signal
process.on('SIGTERM', () => {
    logger.info('SIGTERM RECEIVED. Shutting down gracefully');
    server.close(() => {
        logger.info('Process terminated!');
    });
});

export default app;