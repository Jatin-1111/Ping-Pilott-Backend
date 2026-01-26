import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

// Database configuration
import * as db from './db.js';

// Cron job configuration
import cron from './cron.js';

// Application configuration
const config = {
    env: process.env.NODE_ENV || 'development',
    port: process.env.PORT || 5000,

    // MongoDB settings
    db: {
        uri: process.env.MONGO_URI,
        options: db.mongoOptions
    },

    // JWT settings
    jwt: {
        secret: process.env.JWT_SECRET,
        expiresIn: process.env.JWT_EXPIRES_IN || '1d',
        refreshSecret: process.env.JWT_REFRESH_SECRET,
        refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d'
    },

    // Email settings
    email: {
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        user: process.env.SMTP_USER,
        password: process.env.SMTP_PASSWORD,
        fromEmail: process.env.SMTP_FROM_EMAIL
    },

    // Frontend URL (for email links)
    frontendUrl: process.env.FRONTEND_URL || 'http://pingpilott.vercel.app',

    // Rate limiting
    rateLimit: {
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
        max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
        authMax: parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 10
    },

    // Monitoring settings
    monitoring: {
        defaultCheckFrequency: parseInt(process.env.DEFAULT_CHECK_FREQUENCY) || 5,
        defaultResponseThreshold: parseInt(process.env.DEFAULT_RESPONSE_THRESHOLD) || 1000
    },

    // Data retention (days)
    retention: {
        checkDataDays: parseInt(process.env.CHECK_DATA_RETENTION_DAYS) || 7,
        logRetentionDays: parseInt(process.env.LOG_RETENTION_DAYS) || 30
    },

    // Cron configuration
    cron
};

export default config;