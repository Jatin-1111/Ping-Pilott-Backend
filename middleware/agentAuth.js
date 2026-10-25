// middleware/agentAuth.js - who is a host agent: the server its token belongs to, if its owner's plan allows agents
//
// A different door from `protect`: no user session, no cookie. The token names one server and can do one thing, send that
// server's metrics. Every refusal for a token that does not work reads the same, so the response says nothing about
// which part was wrong.

import Server from '../models/Server.js';
import User from '../models/User.js';
import { parseToken, bearerToken, secretMatches } from '../utils/agentToken.js';
import { hostMetricsEnabled } from '../utils/hostMetrics.js';
import { hostMetricsAllowance } from '../utils/planFeatures.js';
import logger from '../utils/logger.js';

const refuse = (res, status, message, code) => res.status(status).json({ status: 'error', message, code });

// An agent calls once a minute, so who owns its server (and on which plan) is remembered for half a minute rather than
// read every time. This is its own cache of two fields: utils/userCache.js holds whole users for the sign-in, and a
// partial one in there would be mistaken for a complete one.
const OWNER_CACHE_MS = 30 * 1000;
const OWNER_CACHE_MAX = 1000;
const owners = new Map();

const defaults = {
    findServer: (tokenId) => Server.findOne({ 'agent.tokenId': tokenId })
        .select('agent.enabled agent.tokenId agent.tokenHash uploadedBy name')
        .lean(),
    findOwner: async (id) => {
        const key = String(id);
        const hit = owners.get(key);
        if (hit && hit.expires > Date.now()) return hit.owner;
        const found = await User.findById(id).select('role subscription.plan').lean();
        if (found) {
            if (owners.size >= OWNER_CACHE_MAX) owners.delete(owners.keys().next().value);
            owners.set(key, { owner: found, expires: Date.now() + OWNER_CACHE_MS });
        }
        return found;
    },
    enabled: hostMetricsEnabled
};

/**
 * @param {Object} [deps]  replaceable in tests
 * @returns {import('express').RequestHandler}  sets req.agent = { server, owner } for the handler after it
 */
export function createAgentAuth(deps = {}) {
    const { findServer, findOwner, enabled } = { ...defaults, ...deps };

    return async (req, res, next) => {
        try {
            if (!enabled()) return refuse(res, 404, 'Not found', 'NOT_FOUND');

            const token = parseToken(bearerToken(req.headers.authorization));
            const server = token ? await findServer(token.tokenId) : null;
            // the same work whether or not there is a server, so a wrong id and a wrong secret take as long to refuse
            const good = secretMatches(token?.secret ?? '', server?.agent?.tokenHash);
            if (!token || !server || !server.agent?.enabled || !good) {
                return refuse(res, 401, 'Invalid agent token', 'INVALID_AGENT_TOKEN');
            }

            const owner = await findOwner(server.uploadedBy);
            if (!owner) return refuse(res, 401, 'Invalid agent token', 'INVALID_AGENT_TOKEN');
            if (!hostMetricsAllowance(owner).enabled) {
                return refuse(res, 403, 'Host metrics are not part of this account\'s plan', 'PLAN_REQUIRED');
            }

            req.agent = { server, owner };
            next();
        } catch (err) {
            logger.error(`Agent sign-in failed: ${err.message}`);
            refuse(res, 500, 'Something went wrong, try again shortly', 'SERVER_ERROR');
        }
    };
}

export default createAgentAuth();
