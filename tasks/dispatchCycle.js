// tasks/dispatchCycle.js - one scheduler cycle: queue a check for every server that is due
//
// Separate from checkServers.js (which wires it to the database and the queue) so the rules can be tested on their own.
// A cycle that could not do its job THROWS. It used to catch everything and return `{ error }`, which the job queue
// counted as a success, so the stall watchdog and /health said "ok" for as long as the database or Redis was down.

/**
 * @param {Object} p
 * @param {Date} p.tick                         the minute this cycle belongs to
 * @param {(tick: Date) => Promise<Array>} p.findDue          servers that are due now
 * @param {(server, tick: Date) => Promise<boolean>} p.addJob  queue one check; false when it could not be queued
 * @param {(servers: Array, tick: Date) => Promise<void>} p.bookNext  record each server's next slot
 * @returns {Promise<{ total: number, dispatched: number }>}
 * @throws when the due servers could not be read, when none of them could be queued, or when the next slots could
 *         not be saved
 */
export async function dispatchCycle({ tick, findDue, addJob, bookNext }) {
    const servers = await findDue(tick);
    if (!servers?.length) return { total: 0, dispatched: 0 };

    const dispatched = [];
    await Promise.all(servers.map(async (server) => {
        if (await addJob(server, tick)) dispatched.push(server);
    }));

    // Some failing is a bad minute (those servers stay due and are tried next cycle). Nothing queued means the queue
    // is down, and that has to show.
    if (dispatched.length === 0) {
        throw new Error(`Could not queue any of the ${servers.length} due checks (is Redis reachable?)`);
    }

    await bookNext(dispatched, tick);

    return { total: servers.length, dispatched: dispatched.length };
}

export default { dispatchCycle };
