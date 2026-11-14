// utils/userLock.js - run a piece of work one at a time for a given key
//
// Why: creating a monitor is "look for a duplicate, count the user's servers, insert". Run as separate steps by parallel
// requests, every request counted the same servers and every request passed: 12 concurrent creates on a plan that allows
// 5 all succeeded. Taking a lock named after the user makes those three steps happen one request at a time, so the
// count is true when it is read.
//
// How: a lock is one document in the `locks` collection whose _id is the lock name. Taking it is a single atomic upsert
// that only matches when no valid lock is there (none, or one whose expiresAt has passed). If a valid lock is held the
// upsert tries to insert the same _id and MongoDB answers with a duplicate-key error, so the caller waits a moment and
// tries again. A holder that crashes frees the lock by itself when its ttl passes.

import crypto from 'node:crypto';
import logger from './logger.js';

export class LockBusyError extends Error {
    constructor(key) {
        super(`Could not take the lock "${key}": another request is still holding it`);
        this.name = 'LockBusyError';
        this.code = 'LOCK_BUSY';
        this.key = key;
    }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DUPLICATE_KEY = 11000;

/**
 * @param {Object} deps  all replaceable in tests
 * @param {{ updateOne: Function, deleteOne: Function }} deps.model  the Lock model
 * @param {number} [deps.ttlMs]   how long a held lock stays valid if its holder never releases it
 * @param {number} [deps.waitMs]  how long to keep trying before giving up with a LockBusyError
 * @param {number} [deps.pollMs]  pause between tries
 */
export function createLocker({
    model,
    now = Date.now,
    sleep = defaultSleep,
    randomId = () => crypto.randomUUID(),
    ttlMs = 15000,
    waitMs = 5000,
    pollMs = 40
}) {
    async function acquire(key) {
        const owner = randomId();
        const deadline = now() + waitMs;

        for (;;) {
            try {
                await model.updateOne(
                    { _id: key, expiresAt: { $lt: new Date(now()) } },
                    { $set: { owner, expiresAt: new Date(now() + ttlMs) } },
                    { upsert: true }
                );
                return owner;
            } catch (error) {
                if (error?.code !== DUPLICATE_KEY) throw error;
                if (now() >= deadline) throw new LockBusyError(key);
                await sleep(pollMs);
            }
        }
    }

    async function release(key, owner) {
        try {
            // only the holder's own lock: if ours expired and someone else took it, leave theirs alone
            await model.deleteOne({ _id: key, owner });
        } catch (error) {
            // it frees itself at expiresAt; failing to delete early must not turn a finished request into an error
            logger.warn(`Could not release lock ${key}: ${error.message}`);
        }
    }

    /** Run `work` while holding the lock `key`. Throws LockBusyError if the lock cannot be taken within waitMs. */
    async function withLock(key, work) {
        const owner = await acquire(key);
        try {
            return await work();
        } finally {
            await release(key, owner);
        }
    }

    return { withLock, acquire, release };
}

export default { createLocker, LockBusyError };
