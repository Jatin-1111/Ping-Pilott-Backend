// tasks/hostMissing.js - tells the owner when a host agent has gone quiet
//
// An agent that stopped sends nothing, so nothing arrives to react to: this runs every minute and looks for servers whose
// agent has not been heard from for longer than the owner's limit (5 minutes unless they changed it). It says so once; when
// the agent reports again, the next reading says that it is back (controllers/hostAgentController.js).
//
// It leaves alone: an agent that has never reported (it is not installed yet, which is not an outage), an agent that has been
// told already, an owner whose plan no longer includes agents (ingest refuses it, so of course it is quiet), and any owner who
// cannot be told right now (alerts off, outside their alert hours), who hears at the first sweep after they can be.
// Everything is passed in, so the rules run in tests without a database.

import Server from '../models/Server.js';
import User from '../models/User.js';
import { hostAlertSettings, missingDecision, markMissing, LIMITS } from '../utils/hostAlerts.js';
import { hostMetricsAllowance } from '../utils/planFeatures.js';
import { shouldSendAlert } from '../services/alertService.js';
import logger from '../utils/logger.js';

const BATCH = 500;
const MINUTE = 60 * 1000;

const defaults = {
    // Servers whose agent was last heard from before `cutoff` and has not been told about yet. The cutoff is the shortest any
    // owner can have set, so each server is then judged against its own limit.
    findQuiet: (cutoff) => Server.find({
        'agent.enabled': true,
        'agent.lastSeenAt': { $lt: cutoff },
        'agent.alerts.missing.alerted': { $ne: true }
    })
        .select('agent.enabled agent.lastSeenAt agent.alerts agent.alertsRev uploadedBy name url status priority timezone monitoring contactEmails')
        .limit(BATCH)
        .lean(),
    findOwners: (ids) => User.find({ _id: { $in: ids } }).select('role subscription.plan').lean(),
    // Only if nobody has saved the alert state since it was read, and the alert has not been raised meanwhile
    saveState: async (id, state, rev) => {
        const result = await Server.updateOne(
            { _id: id, 'agent.alertsRev': rev ?? null, 'agent.alerts.missing.alerted': { $ne: true } },
            { $set: { 'agent.alerts': state }, $inc: { 'agent.alertsRev': 1 } }
        );
        return result.matchedCount === 1;
    },
    shouldSend: shouldSendAlert,
    // Loaded when needed: the queue opens a Redis connection as soon as it is imported
    enqueueAlert: async (args) => {
        const [{ enqueueAlert }, { default: PendingAlert }, { addAlertToQueue }] = await Promise.all([
            import('../services/alertOutbox.js'), import('../models/PendingAlert.js'), import('../queues/alertQueue.js')
        ]);
        return enqueueAlert(args, { model: PendingAlert, queue: { add: addAlertToQueue } });
    },
    now: () => Date.now()
};

/**
 * @param {Object} [deps]  replaceable in tests
 * @returns {Promise<{ checked: number, raised: number }>}  never throws for one server: a problem with one does not hold back the rest
 */
export async function runHostMissingSweep(deps = {}) {
    const d = { ...defaults, ...deps };
    const now = d.now();
    const quiet = await d.findQuiet(new Date(now - LIMITS.missingMinutes[0] * MINUTE));
    if (quiet.length === 0) return { checked: 0, raised: 0 };

    const owners = new Map((await d.findOwners([...new Set(quiet.map((s) => String(s.uploadedBy)))])).map((o) => [String(o._id), o]));

    let raised = 0;
    for (const server of quiet) {
        try {
            const owner = owners.get(String(server.uploadedBy));
            if (!owner || !hostMetricsAllowance(owner).enabled) continue;

            const decision = missingDecision({ settings: hostAlertSettings(server.monitoring?.hostAlerts), agent: server.agent, now });
            if (!decision) continue;
            if (!d.shouldSend(server)) continue; // not now: the next sweep tries again, so they are told when they can be

            const state = markMissing(server.agent.alerts, now, Date.parse(decision.lastSeen));
            if (!(await d.saveState(server._id, state, server.agent.alertsRev))) continue; // another process has it

            await d.enqueueAlert({
                server,
                alertType: decision.type,
                previous: server.status,
                // when the checks also see the server down, the whole machine may be off, which the alert says
                checkResult: { status: server.status, host: { ...decision, ...(server.status === 'down' ? { alsoDown: true } : {}) } }
            });
            raised += 1;
        } catch (err) {
            logger.error(`Could not check whether the agent on ${server.name || server._id} has gone quiet: ${err.message}`);
        }
    }
    if (raised > 0) logger.info(`Host agents gone quiet: ${raised} alert${raised === 1 ? '' : 's'} raised`);
    return { checked: quiet.length, raised };
}

export default { runHostMissingSweep };
