import mongoose from 'mongoose';
import logger from '../utils/logger.js';

/**
 * How many connections ONE process may open to MongoDB (MONGO_MAX_POOL_SIZE, default 50).
 * The cluster's connection limit is shared by every process that connects: the API, each monitor worker, the alert worker and
 * the scheduler. At 100 each, three to five processes asked for 300 to 500, which is the whole limit of the smallest shared
 * Atlas tiers. Size the total, not each pool: processes x pool must stay well under the cluster's limit.
 */
export const poolSize = (env = process.env) => {
    const n = parseInt(env.MONGO_MAX_POOL_SIZE, 10);
    return Number.isInteger(n) && n > 0 ? n : 50;
};

/**
 * MongoDB connection options
 */
const mongoOptions = {
    // Connection pooling settings
    maxPoolSize: poolSize(),
    minPoolSize: 5,    // Default: 0
    socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
    family: 4,         // Use IPv4, skip trying IPv6
    serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
    heartbeatFrequencyMS: 10000, // Check server health every 10 seconds
};

/**
 * Connect to MongoDB database
 * Creates a single connection pool that's shared across the entire application
 */
export const connectDB = async () => {
    try {
        const conn = await mongoose.connect(process.env.MONGO_URI, mongoOptions);

        logger.info(`MongoDB Connected: ${conn.connection.host}`);

        // Set up connection event listeners
        mongoose.connection.on('error', (err) => {
            logger.error(`MongoDB connection error: ${err}`);
        });

        mongoose.connection.on('disconnected', () => {
            logger.warn('MongoDB disconnected, trying to reconnect...');
        });

        mongoose.connection.on('reconnected', () => {
            logger.info('MongoDB reconnected');
        });

        // Handle graceful shutdown
        process.on('SIGINT', async () => {
            try {
                await mongoose.connection.close();
                logger.info('MongoDB connection closed through app termination');
                process.exit(0);
            } catch (err) {
                logger.error(`Error during MongoDB connection close: ${err}`);
                process.exit(1);
            }
        });

        return conn;
    } catch (error) {
        logger.error(`Error connecting to MongoDB: ${error.message}`);
        process.exit(1);
    }
};

/**
 * Get the current MongoDB connection
 * @returns {mongoose.Connection} The active MongoDB connection
 */
export const getConnection = () => mongoose.connection;

/**
 * Close the MongoDB connection
 */
export const closeConnection = async () => {
    try {
        await mongoose.connection.close();
        logger.info('MongoDB connection closed');
    } catch (error) {
        logger.error(`Error closing MongoDB connection: ${error.message}`);
        throw error;
    }
};

export default { connectDB, getConnection, closeConnection };