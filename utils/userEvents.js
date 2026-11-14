// utils/userEvents.js - tell every API process that an account changed in a way that ends sessions
//
// A password change, a role change, a deletion or "sign out everywhere" must take effect at once, on every API process:
//  - the 15 s in-process user cache (utils/userCache.js) is dropped, so the next request reads the new state;
//  - the user's open sockets are closed (they were authenticated once, at connect), so a demoted admin stops getting every
//    user's updates and a stale token stops receiving live status. Clients reconnect with their current token.
// The process that made the change does this directly and also publishes on Redis; other API processes do it when they
// receive the message. Without that, only the process that handled the request would notice.

import crypto from 'node:crypto';
import { redisConnection } from '../config/redis.js';
import { disconnectUserSockets } from '../config/socket.js';
import { userCache } from './userCache.js';
import { withTimeout } from './timeout.js';
import logger from './logger.js';

export const USER_CHANGED_CHANNEL = 'user-changed';
const INSTANCE_ID = crypto.randomUUID();
const PUBLISH_TIMEOUT_MS = 300;

function apply(userId, disconnect) {
    userCache.invalidate(userId);
    if (disconnect) disconnectUserSockets(userId);
}

/**
 * Call after the change is saved.
 * @param {string|Object} userId
 * @param {{ disconnect?: boolean }} [options]  disconnect: also close the user's sockets (default true)
 */
export async function userChanged(userId, { disconnect = true } = {}) {
    const id = String(userId);
    apply(id, disconnect);
    try {
        // Redis commands wait for ever while it is down, so this must not be awaited without a limit
        await withTimeout(
            redisConnection.publish(USER_CHANGED_CHANNEL, JSON.stringify({ from: INSTANCE_ID, userId: id, disconnect })),
            PUBLISH_TIMEOUT_MS,
            'Publishing a user change'
        );
    } catch (error) {
        logger.warn(`Could not tell other API processes about a change to user ${id}: ${error.message}`);
    }
}

/** The subscriber's handler (index.js) for messages from other API processes */
export function handleUserChangedMessage(message) {
    let event;
    try {
        event = JSON.parse(message);
    } catch {
        logger.warn('Ignoring an unreadable user-changed message');
        return;
    }
    if (!event?.userId || event.from === INSTANCE_ID) return; // our own message: already applied
    apply(String(event.userId), event.disconnect !== false);
}

export default { userChanged, handleUserChangedMessage, USER_CHANGED_CHANNEL };
