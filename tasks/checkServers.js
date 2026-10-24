// tasks/checkServers.js - Redis Queue Dispatcher
import logger from '../utils/logger.js';
import Server from '../models/Server.js';
import { addCheckJob } from '../queues/monitorQueue.js';
import { isWithinCheckSchedule, timezoneOf } from '../utils/schedule.js';
import { tickOf, nextCheckSlot } from '../utils/checkSchedule.js';
import { dispatchCycle } from './dispatchCycle.js';

/**
 * MAIN: Dispatch server checks to the queue
 * Finds servers whose `nextCheckAt` has passed and adds them to BullMQ.
 *
 * Each server is due at (previous tick + its frequency). Comparing against a fixed schedule instead of
 * "now - lastChecked" matters: lastChecked is written after the check finishes, so that comparison was
 * always a few seconds short and a 1-minute monitor ended up checked every 2 minutes.
 */
export const checkAllServersIntelligently = async () => {
    const startTime = Date.now();
    // The minute this run belongs to; it is the clock every schedule is counted from
    const tick = tickOf(startTime);

    logger.info('🧠 SCHEDULER: Starting check cycle via Redis Queue...');

    // A failed cycle throws (see dispatchCycle.js): the job queue logs it and the watchdog and /health see it
    const result = await dispatchCycle({
        tick,
        findDue: getDueServers,
        addJob: addCheckJob,
        // Book the next slot right away. If a worker is slow or dies, the next cycle will not dispatch a duplicate.
        bookNext: (servers) => Server.bulkWrite(servers.map((server) => ({
            updateOne: {
                filter: { _id: server._id },
                update: { $set: { nextCheckAt: nextCheckSlot(tick, server.monitoring?.frequency) } }
            }
        })), { ordered: false })
    });

    if (result.total === 0) {
        logger.debug('No servers need checking right now');
    } else {
        logger.info(`✅ SCHEDULER: Dispatched ${result.dispatched}/${result.total} jobs in ${Date.now() - startTime}ms`);
    }

    return result;
};

/**
 * Servers that are due: never scheduled (no nextCheckAt, e.g. just created or created before this field
 * existed) or whose slot has arrived. Uses the nextCheckAt index instead of scanning every server.
 */
const getDueServers = async (tick) => {
    const servers = await Server.find({
        $or: [
            { nextCheckAt: null },
            { nextCheckAt: { $lte: tick } }
        ]
    }, {
        name: 1,
        url: 1,
        type: 1,
        priority: 1,
        status: 1,
        monitoring: 1,
        timezone: 1,
        lastChecked: 1,
        uploadedRole: 1,
        uploadedPlan: 1
    }).lean().maxTimeMS(20000); // a database that stops answering must not hold the scheduler

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

    // Check days and hours, read in the server's own timezone
    return isWithinCheckSchedule(server.monitoring, timezoneOf(server));
};

export default { checkAllServersIntelligently };