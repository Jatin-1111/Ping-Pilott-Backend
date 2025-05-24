// migrations/001_create_indexes.js
import mongoose from 'mongoose';
import logger from '../utils/logger.js';

/**
 * Create optimized indexes for better query performance
 * Run this once to set up all necessary indexes
 */
export const createOptimizedIndexes = async () => {
    try {
        logger.info('🚀 Starting index creation process...');

        const db = mongoose.connection.db;

        // 1. Server collection indexes
        const serverCollection = db.collection('servers');
        await Promise.all([
            // Primary query patterns
            serverCollection.createIndex({ uploadedBy: 1, status: 1 }),
            serverCollection.createIndex({ uploadedBy: 1, lastChecked: 1 }),
            serverCollection.createIndex({ status: 1, lastChecked: 1 }),
            serverCollection.createIndex({ 'monitoring.frequency': 1, lastChecked: 1 }),

            // Search and filtering
            serverCollection.createIndex({ name: 'text', url: 'text', description: 'text' }),
            serverCollection.createIndex({ type: 1, status: 1 }),
            serverCollection.createIndex({ createdAt: -1 }),

            // Monitoring specific
            serverCollection.createIndex({ 'monitoring.trialEndsAt': 1 }),
            serverCollection.createIndex({ uploadedRole: 1, uploadedPlan: 1 })
        ]);

        // 2. ServerCheck collection indexes (most critical for analytics)
        const serverCheckCollection = db.collection('serverchecks');
        await Promise.all([
            // Time-series queries (most important)
            serverCheckCollection.createIndex({ serverId: 1, timestamp: -1 }),
            serverCheckCollection.createIndex({ serverId: 1, localDate: 1, localHour: 1 }),
            serverCheckCollection.createIndex({ timestamp: -1 }),

            // Analytics queries
            serverCheckCollection.createIndex({ localDate: 1, status: 1 }),
            serverCheckCollection.createIndex({ serverId: 1, status: 1, timestamp: -1 }),
            serverCheckCollection.createIndex({ status: 1, timestamp: -1 }),

            // Cleanup queries
            serverCheckCollection.createIndex({ localDate: 1 })
        ]);

        // 3. User collection indexes
        const userCollection = db.collection('users');
        await Promise.all([
            // Auth and role queries
            userCollection.createIndex({ email: 1 }, { unique: true }),
            userCollection.createIndex({ role: 1 }),
            userCollection.createIndex({ 'subscription.plan': 1, role: 1 }),
            userCollection.createIndex({ createdAt: -1 }),
            userCollection.createIndex({ emailVerified: 1 }),

            // Token lookups
            userCollection.createIndex({ verificationToken: 1 }),
            userCollection.createIndex({ resetToken: 1 })
        ]);

        // 4. CronJob collection indexes
        const cronJobCollection = db.collection('cronjobs');
        await Promise.all([
            cronJobCollection.createIndex({ name: 1, startedAt: -1 }),
            cronJobCollection.createIndex({ status: 1, startedAt: -1 }),
            cronJobCollection.createIndex({ startedAt: -1 })
        ]);

        // 5. SupportTicket collection indexes
        const supportTicketCollection = db.collection('supporttickets');
        await Promise.all([
            supportTicketCollection.createIndex({ userId: 1, status: 1 }),
            supportTicketCollection.createIndex({ status: 1, priority: 1, createdAt: -1 }),
            supportTicketCollection.createIndex({ userPlan: 1, status: 1 }),
            supportTicketCollection.createIndex({ createdAt: -1 })
        ]);

        logger.info('✅ All indexes created successfully!');

        // Log index usage stats
        const serverIndexes = await serverCollection.listIndexes().toArray();
        const checkIndexes = await serverCheckCollection.listIndexes().toArray();

        logger.info(`📊 Created ${serverIndexes.length} indexes on servers collection`);
        logger.info(`📊 Created ${checkIndexes.length} indexes on serverchecks collection`);

        return {
            success: true,
            serverIndexes: serverIndexes.length,
            checkIndexes: checkIndexes.length
        };

    } catch (error) {
        logger.error(`❌ Error creating indexes: ${error.message}`);
        throw error;
    }
};

/**
 * Check existing indexes and their usage
 */
export const analyzeIndexUsage = async () => {
    try {
        const db = mongoose.connection.db;
        const collections = ['servers', 'serverchecks', 'users'];

        for (const collName of collections) {
            const collection = db.collection(collName);
            const stats = await collection.stats();
            const indexes = await collection.listIndexes().toArray();

            logger.info(`📈 Collection: ${collName}`);
            logger.info(`   Documents: ${stats.count}`);
            logger.info(`   Indexes: ${indexes.length}`);
            logger.info(`   Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
        }

    } catch (error) {
        logger.error(`Error analyzing indexes: ${error.message}`);
    }
};

// CLI script to run migrations
if (import.meta.url === `file://${process.argv[1]}`) {
    import('../config/db.js').then(async ({ connectDB }) => {
        await connectDB();
        await createOptimizedIndexes();
        await analyzeIndexUsage();
        process.exit(0);
    });
}

export default { createOptimizedIndexes, analyzeIndexUsage };