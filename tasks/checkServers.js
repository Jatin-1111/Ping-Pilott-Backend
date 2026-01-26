// tasks/checkServers.js - Redis Queue Dispatcher
import logger from '../utils/logger.js';
import Server from '../models/Server.js';
import { addCheckJob } from '../queues/monitorQueue.js';

/**
 * MAIN: Dispatch server checks to the queue
 * Finds servers due for checking and adds them to BullMQ
 */
export const checkAllServersIntelligently = async () => {
    const startTime = Date.now();

    logger.info('🧠 SCHEDULER: Starting check cycle via Redis Queue...');

    try {
        // Get servers with intelligent prioritization
        const servers = await getServersWithPriority();

        if (!servers?.length) {
            logger.debug('No servers need checking right now');
            return { total: 0, dispatched: 0 };
        }

        logger.info(`Found ${servers.length} servers to check - dispatching to queue`);

        // Dispatch jobs in parallel but await completeness
        let dispatched = 0;
        const promises = servers.map(async (server) => {
            const added = await addCheckJob(server, server.priority);
            if (added) dispatched++;
        });

        await Promise.all(promises);

        const duration = Date.now() - startTime;
        logger.info(`✅ SCHEDULER: Dispatched ${dispatched}/${servers.length} jobs in ${duration}ms`);

        return { total: servers.length, dispatched };

    } catch (error) {
        logger.error(`❌ SCHEDULER ERROR: ${error.message}`);
        return { total: 0, dispatched: 0, error: error.message };
    }
};

/**
 * Get servers with intelligent prioritization (system time)
 */
const getServersWithPriority = async () => {
    const now = new Date();

    // Smart query - only get servers that ACTUALLY need checking
    const query = {
        $or: [
            { lastChecked: null },
            {
                $expr: {
                    $gte: [
                        { $subtract: [now, '$lastChecked'] },
                        {
                            $multiply: [
                                {
                                    // Strictly follow user's configured frequency
                                    $ifNull: ['$monitoring.frequency', 5]
                                },
                                60000 // Convert to milliseconds
                            ]
                        }
                    ]
                }
            }
        ]
    };

    const servers = await Server.find(query, {
        name: 1,
        url: 1,
        type: 1,
        priority: 1,
        status: 1,
        monitoring: 1,
        lastChecked: 1,
        uploadedRole: 1,
        uploadedPlan: 1
    }).lean();

    return servers.filter(shouldMonitorServer);
};

/**
 * Check if server should be monitored
 */
const shouldMonitorServer = (server) => {
    // Admin servers always monitored
    if (server.uploadedRole === 'admin' || server.uploadedPlan === 'admin') {
        return true;
    }

    // Check trial expiry
    if (server.uploadedPlan === 'free' &&
        server.monitoring?.trialEndsAt &&
        new Date(server.monitoring.trialEndsAt) < new Date()) {
        return false;
    }

    // Check time windows if defined
    if (server.monitoring?.timeWindows?.length || server.monitoring?.daysOfWeek?.length) {
        const now = new Date();
        const currentDay = now.getDay();
        const currentTime = now.getHours().toString().padStart(2, '0') + ':' +
            now.getMinutes().toString().padStart(2, '0');

        // Check days of week
        if (server.monitoring?.daysOfWeek?.length > 0) {
            if (!server.monitoring.daysOfWeek.includes(currentDay)) {
                return false;
            }
        }

        // Check time windows
        if (server.monitoring?.timeWindows?.length > 0) {
            // Special case: 00:00 to 00:00 means 24/7
            if (server.monitoring.timeWindows.some(w => w.start === '00:00' && w.end === '00:00')) {
                return true;
            }

            return server.monitoring.timeWindows.some(window => {
                if (window.start <= window.end) {
                    // Standard window (e.g. 09:00 to 17:00)
                    return currentTime >= window.start && currentTime <= window.end;
                } else {
                    // Overnight window (e.g. 22:00 to 06:00)
                    return currentTime >= window.start || currentTime <= window.end;
                }
            });
        }
    }

    return true;
};

export default { checkAllServersIntelligently };