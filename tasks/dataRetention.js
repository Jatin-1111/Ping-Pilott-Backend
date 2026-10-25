// tasks/dataRetention.js - the midnight clean-up of old history

import logger from '../utils/logger.js';
import ServerCheck from '../models/ServerCheck.js';
import Incident from '../models/Incident.js';
import CronJob from '../models/CronJob.js';
import mongoose from 'mongoose';
import { resolveRetentionDays } from '../utils/retention.js';

/**
 * What to do to incidents when the checks they came from are gone. An incident keeps what the server said (its page, its
 * headers) only as long as the check history is kept: it is somebody else's page, and the rest of the incident (when,
 * how long, what step, what status) is worth keeping for its 90 days.
 * @param {Date} cutoff  checks older than this are deleted
 * @returns {{ filter: Object, update: Object }}
 */
export const incidentEvidenceExpiry = (cutoff) => ({
    filter: { startedAt: { $lt: cutoff }, evidence: { $ne: null } },
    update: { $unset: { evidence: '' } }
});

/**
 * Delete check history older than the retention period, and job logs older than a week.
 * @param {Number} days - How many days of checks to keep (default: CHECK_DATA_RETENTION_DAYS, 30)
 * @returns {Object} Statistics about the cleanup process
 */
export const runDataRetention = async (days = resolveRetentionDays(process.env.CHECK_DATA_RETENTION_DAYS).days) => {
    const startTime = Date.now();
    logger.info(`Starting data clean-up (keeping the last ${days} days of checks)...`);

    const stats = {
        serverChecksDeleted: 0,
        cronJobsDeleted: 0,
        incidentEvidenceCleared: 0,
        serverChecksKept: 0,
        retentionDays: days,
        duration: 0
    };

    try {
        const cutoffTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        logger.info(`Deleting ServerCheck records older than ${cutoffTime.toISOString()}`);

        const serverCheckResult = await ServerCheck.deleteMany({
            timestamp: { $lt: cutoffTime }
        });
        stats.serverChecksDeleted = serverCheckResult.deletedCount;

        stats.serverChecksKept = await ServerCheck.countDocuments();

        // What an incident kept of the failing page goes with the checks
        const expiry = incidentEvidenceExpiry(cutoffTime);
        const evidenceResult = await Incident.updateMany(expiry.filter, expiry.update);
        stats.incidentEvidenceCleared = evidenceResult.modifiedCount || 0;

        // Job logs are for debugging: a week is plenty
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const cronJobResult = await CronJob.deleteMany({
            startedAt: { $lt: weekAgo }
        });
        stats.cronJobsDeleted = cronJobResult.deletedCount;

        stats.duration = Date.now() - startTime;

        logger.info('Data clean-up completed', stats);
        return { ...stats, success: true };

    } catch (error) {
        stats.duration = Date.now() - startTime;
        logger.error(`Error in data retention: ${error.message}`, {
            stack: error.stack,
            stats
        });

        throw error;
    }
};

/**
 * Size of the database in MB (data plus indexes), for the 15 minute health log
 */
export const getDatabaseSizeMB = async () => {
    const dbStats = await mongoose.connection.db.stats();
    return Math.round((dbStats.dataSize + dbStats.indexSize) / 1024 / 1024);
};

export default { runDataRetention, incidentEvidenceExpiry, getDatabaseSizeMB };
