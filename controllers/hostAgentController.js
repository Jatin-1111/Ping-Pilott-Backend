// controllers/hostAgentController.js - host agents: the endpoint they send to, and the owner's controls for them
//
// Ingest (POST /api/agent/v1/metrics) is called by the agent with its token (middleware/agentAuth.js).
// The owner's routes (/api/servers/:id/agent...) use the signed-in user like the rest of the server routes: only the
// owner (or an admin) can turn an agent on, replace its token or turn it off, and the token is only ever in the response
// that makes it.

import mongoose from 'mongoose';
import Server from '../models/Server.js';
import User from '../models/User.js';
import HostMetric from '../models/HostMetric.js';
import HostMetric5m from '../models/HostMetric5m.js';
import { generateToken } from '../utils/agentToken.js';
import { parseIngest, hostMetricsEnabled, INTERVAL_SECONDS, MIN_AGENT_VERSION, apiBaseOf, installCommands } from '../utils/hostMetrics.js';
import { hostMetricsAllowance } from '../utils/planFeatures.js';
import { hostAlertSettings, evaluateSnapshots } from '../utils/hostAlerts.js';
import { shouldSendAlert } from '../services/alertService.js';
import { PERIODS, DEFAULT_PERIOD, pointFromRaw, longRangePoints, tailStart, latestOf, agentStatus, mountsOf } from '../utils/hostSeries.js';
import logger from '../utils/logger.js';

const fail = (res, status, message, code, extra = {}) => res.status(status).json({ status: 'error', message, code, ...extra });

const defaults = {
    insertPoints: (docs) => HostMetric.insertMany(docs, { ordered: false }),
    touchServer: (id, set) => Server.updateOne({ _id: id }, { $set: set }),
    // Save the reading's effects and the alert state together, but only if nobody has saved the state since it was read
    // (agent.alertsRev counts the saves): two readings that arrive together cannot both raise the same alert.
    saveReading: async (id, set, rev) => {
        const result = await Server.updateOne({ _id: id, 'agent.alertsRev': rev ?? null }, { $set: set, $inc: { 'agent.alertsRev': 1 } });
        return result.matchedCount === 1;
    },
    // Is the owner to be told right now (alerts on, inside their alert hours)
    shouldSend: shouldSendAlert,
    // Loaded when needed: the queue opens a Redis connection as soon as it is imported
    enqueueAlert: async (args) => {
        const [{ enqueueAlert }, { default: PendingAlert }, { addAlertToQueue }] = await Promise.all([
            import('../services/alertOutbox.js'), import('../models/PendingAlert.js'), import('../queues/alertQueue.js')
        ]);
        return enqueueAlert(args, { model: PendingAlert, queue: { add: addAlertToQueue } });
    },
    findOwner: (id) => User.findById(id).select('role subscription.plan').lean(),
    findServer: (id) => Server.findById(id).select('uploadedBy name agent').lean(),
    countAgents: (ownerId, exceptId) => Server.countDocuments({ uploadedBy: ownerId, 'agent.enabled': true, _id: { $ne: exceptId } }),
    saveAgent: (id, update) => Server.updateOne({ _id: id }, update),
    deletePoints: (id) => Promise.all([HostMetric.deleteMany({ serverId: id }), HostMetric5m.deleteMany({ serverId: id })]),
    // A range of one server's raw snapshots, oldest first. Capped, so an agent that misbehaves cannot make a page heavy:
    // the newest are kept, because the end of a chart is the part that matters.
    readRaw: async (id, from, limit = 1500) => (await HostMetric.find({ serverId: id, timestamp: { $gte: from } })
        .sort({ timestamp: -1 }).limit(limit).select('-_id -serverId').lean()).reverse(),
    readRollups: (id, from) => HostMetric5m.find({ serverId: id, bucket: { $gte: from } }).sort({ bucket: 1 }).select('-_id -serverId').lean(),
    readLatest: (id) => HostMetric.findOne({ serverId: id }).sort({ timestamp: -1 }).select('-_id -serverId').lean(),
    // loaded when needed: the cache opens a Redis connection as soon as it is imported
    forgetCache: async (...ids) => {
        const { invalidateServerCache } = await import('../utils/cacheManager.js');
        await Promise.all(ids.map((id) => invalidateServerCache(String(id))));
    },
    enabled: hostMetricsEnabled,
    now: () => Date.now()
};

/** @param {Object} [deps]  replaceable in tests */
export function createHostAgentController(deps = {}) {
    const d = { ...defaults, ...deps };

    /** POST /api/agent/v1/metrics: store what the agent measured. Runs after agentAuth, which sets req.agent. */
    const ingest = async (req, res) => {
        const parsed = parseIngest(req.body, d.now());
        if (!parsed.ok) return fail(res, 422, 'The snapshot is not in the expected format', 'INVALID_PAYLOAD', { issues: parsed.issues });

        const { server } = req.agent;
        const seen = { 'agent.lastSeenAt': new Date(d.now()) };
        const { name, os, arch, agentVersion } = parsed.host;
        if (name) seen['agent.hostname'] = name;
        if (os) seen['agent.os'] = os;
        if (arch) seen['agent.arch'] = arch;
        if (agentVersion) seen['agent.version'] = agentVersion;

        try {
            await d.insertPoints(parsed.points.map((point) => ({ ...point, serverId: server._id })));
        } catch (err) {
            logger.error(`Could not store host metrics for ${server.name || server._id}: ${err.message}`);
            return fail(res, 500, 'Could not store the snapshot, try again shortly', 'SERVER_ERROR');
        }

        // The readings are stored. What follows (judging them against the limits, telling the owner) must not make the agent
        // send them again, so a problem there is logged and the agent is still told they arrived.
        try {
            const previousSeenAt = server.agent?.lastSeenAt ? new Date(server.agent.lastSeenAt).getTime() : null;
            const { state, events } = evaluateSnapshots({
                settings: hostAlertSettings(server.monitoring?.hostAlerts),
                state: server.agent?.alerts,
                points: parsed.points,
                previousSeenAt,
                canAlert: d.shouldSend(server)
            });
            const saved = await d.saveReading(server._id, { ...seen, 'agent.alerts': state }, server.agent?.alertsRev);
            if (saved) {
                for (const event of events) {
                    await d.enqueueAlert({ server, alertType: event.type, previous: server.status, checkResult: { status: server.status, host: event } });
                }
            } else {
                // Another reading moved the state on first and is judging the same stretch. Raise nothing from this one:
                // what it saw is stored, and the next reading judges from the state that won.
                await d.touchServer(server._id, seen);
            }
        } catch (err) {
            logger.error(`Could not judge the host metrics of ${server.name || server._id}: ${err.message}`);
            try { await d.touchServer(server._id, seen); } catch { /* the next reading will say it was seen */ }
        }

        // Nothing is said about what was stored: the agent only needs to know it arrived, and when to come back
        res.status(200).json({ status: 'success', data: { accepted: parsed.points.length, nextIntervalSec: INTERVAL_SECONDS, minAgentVersion: MIN_AGENT_VERSION } });
    };

    // The owner's routes: load the server, and refuse anyone who is not its owner or an admin
    const ownServer = async (req, res, verb = 'change') => {
        if (!d.enabled()) { fail(res, 404, 'Not found', 'NOT_FOUND'); return null; }
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) { fail(res, 400, 'Invalid server ID format', 'INVALID_SERVER_ID'); return null; }

        const server = await d.findServer(req.params.id);
        if (!server) { fail(res, 404, 'Server not found', 'SERVER_NOT_FOUND'); return null; }
        if (String(server.uploadedBy) !== String(req.user.id) && req.user.role !== 'admin') {
            fail(res, 403, `Not authorized to ${verb} this server`, 'UNAUTHORIZED_ACCESS');
            return null;
        }
        return server;
    };

    const publicAgent = (agent) => ({
        enabled: Boolean(agent?.enabled),
        createdAt: agent?.createdAt ?? null,
        lastSeenAt: agent?.lastSeenAt ?? null,
        version: agent?.version ?? null,
        hostname: agent?.hostname ?? null,
        os: agent?.os ?? null,
        arch: agent?.arch ?? null
    });

    /** Make a token for the server and store only its hash. The response is the only time the token is visible. */
    const issue = async (req, res, server, { replacing }) => {
        // The plan that counts is the owner's, also when an admin is the one pressing the button
        const owner = String(server.uploadedBy) === String(req.user.id) ? req.user : await d.findOwner(server.uploadedBy);
        const allowance = hostMetricsAllowance(owner);
        if (!allowance.enabled) return fail(res, 403, 'Host metrics are part of the paid plans', 'PLAN_REQUIRED');

        if (!replacing && (await d.countAgents(server.uploadedBy, server._id)) >= allowance.maxServers) {
            return fail(res, 403, `Your plan includes host metrics on ${allowance.maxServers} server${allowance.maxServers === 1 ? '' : 's'}. Turn one off or upgrade to add more.`, 'AGENT_LIMIT');
        }

        const { token, tokenId, tokenHash } = generateToken();
        const now = new Date(d.now());
        await d.saveAgent(server._id, {
            $set: { 'agent.enabled': true, 'agent.tokenId': tokenId, 'agent.tokenHash': tokenHash, 'agent.createdAt': now },
            // a new token is a new install: what the last one reported is not this one's
            $unset: { 'agent.lastSeenAt': '', 'agent.version': '', 'agent.hostname': '', 'agent.os': '', 'agent.arch': '' }
        });
        await d.forgetCache(server.uploadedBy, req.user.id);

        res.status(replacing ? 200 : 201).json({
            status: 'success',
            message: replacing ? 'New token created. The old one no longer works.' : 'Host metrics turned on',
            // The token and the commands that install it, in the one response that has the token. null if the address of
            // this API is not one that is safe to put in a command (the page then shows the token alone).
            data: {
                token,
                install: installCommands({ token, base: apiBaseOf({ configured: process.env.PUBLIC_API_URL, protocol: req.protocol, host: req.get?.('host') }) }),
                agent: publicAgent({ enabled: true, createdAt: now })
            }
        });
    };

    /** POST /api/servers/:id/agent */
    const enable = async (req, res) => {
        const server = await ownServer(req, res);
        if (!server) return;
        if (server.agent?.enabled) return fail(res, 409, 'Host metrics are already on for this server. Replace the token to install again.', 'AGENT_EXISTS');
        await issue(req, res, server, { replacing: false });
    };

    /** POST /api/servers/:id/agent/rotate */
    const rotate = async (req, res) => {
        const server = await ownServer(req, res);
        if (!server) return;
        if (!server.agent?.enabled) return fail(res, 409, 'Host metrics are not on for this server', 'AGENT_NOT_ENABLED');
        await issue(req, res, server, { replacing: true });
    };

    /** DELETE /api/servers/:id/agent: off at once, and what it sent is deleted */
    const disable = async (req, res) => {
        const server = await ownServer(req, res);
        if (!server) return;
        await d.saveAgent(server._id, { $unset: { agent: '' } });
        await d.deletePoints(server._id);
        await d.forgetCache(server.uploadedBy, req.user.id);
        res.status(200).json({ status: 'success', message: 'Host metrics turned off and their data deleted', data: { agent: publicAgent(null) } });
    };

    /**
     * GET /api/servers/:id/metrics?period=1h|6h|24h|7d|30d
     * What the server page draws: the agent's state, the latest reading in full, and the series for the range.
     * Short ranges are raw snapshots; long ones are the stored 5-minute rows plus what has come in since, folded into
     * steps (utils/hostSeries.js), so a chart has a few hundred points at most.
     */
    const metrics = async (req, res) => {
        const server = await ownServer(req, res, 'view');
        if (!server) return;

        const period = req.query.period === undefined ? DEFAULT_PERIOD : String(req.query.period);
        const range = Object.hasOwn(PERIODS, period) ? PERIODS[period] : null;
        if (!range) return fail(res, 400, `period must be one of ${Object.keys(PERIODS).join(', ')}`, 'INVALID_PERIOD');

        const now = d.now();
        const agent = { ...publicAgent(server.agent), status: agentStatus(server.agent, now) };

        const owner = String(server.uploadedBy) === String(req.user.id) ? req.user : await d.findOwner(server.uploadedBy);
        if (!hostMetricsAllowance(owner).enabled) return fail(res, 403, 'Host metrics are part of the paid plans', 'PLAN_REQUIRED', { data: { agent } });

        // Nothing to read until an agent is on, and nothing is left from one that was turned off
        if (!server.agent?.enabled) return res.status(200).json({ status: 'success', data: { agent, period, binSeconds: 0, latest: null, mounts: [], series: [] } });

        const from = new Date(now - range.rangeMs);
        let series;
        if (range.source === 'raw') {
            series = (await d.readRaw(server._id, from)).map(pointFromRaw);
        } else {
            const rollups = await d.readRollups(server._id, from);
            const tail = await d.readRaw(server._id, new Date(tailStart(rollups, from.getTime())), 600);
            series = longRangePoints(rollups, tail, range.binMs);
        }
        const latest = latestOf(await d.readLatest(server._id));

        res.status(200).json({ status: 'success', data: { agent, period, binSeconds: range.binMs / 1000, latest, mounts: mountsOf(series), series } });
    };

    return { ingest, enable, rotate, disable, metrics };
}

export default createHostAgentController();
