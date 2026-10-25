// utils/threadPool.js - is the libuv thread pool big enough for the lookups checks make?
//
// Every hostname is resolved with dns.lookup, which runs on libuv's thread pool: 4 threads unless UV_THREADPOOL_SIZE says
// otherwise. A lookup for a dead name holds a thread until the resolver gives up, and a worker runs 50 checks at once,
// so a few dead targets can make lookups for healthy ones wait, and that wait shows up as response time.
//
// The variable must be set in the environment of the process itself (Dockerfile, PM2, the host's dashboard). Putting it
// in .env or setting it from code is not reliable: Node may already have used the pool by the time our code runs, and the
// size cannot be changed afterwards. So all this can do is read what the process was started with and say so.

export const RECOMMENDED_THREADS = 16;
const NODE_DEFAULT_THREADS = 4;

/**
 * @param {Object} [env]
 * @returns {{ size: number, ok: boolean, message: string }}
 */
export const describeThreadPool = (env = process.env) => {
    const raw = env.UV_THREADPOOL_SIZE;
    const parsed = parseInt(raw, 10);

    if (raw === undefined || raw === '' || !Number.isFinite(parsed) || parsed < 1) {
        return {
            size: NODE_DEFAULT_THREADS,
            ok: false,
            message: `UV_THREADPOOL_SIZE is not set, so DNS lookups share ${NODE_DEFAULT_THREADS} threads and can queue behind each other, which inflates response times. ` +
                `Set it to ${RECOMMENDED_THREADS} in the process environment (Dockerfile, PM2 or the host's dashboard), not only in .env.`
        };
    }
    if (parsed < RECOMMENDED_THREADS) {
        return {
            size: parsed,
            ok: false,
            message: `UV_THREADPOOL_SIZE is ${parsed}; ${RECOMMENDED_THREADS} is recommended so DNS lookups for slow or dead names do not delay the others.`
        };
    }
    return { size: parsed, ok: true, message: `DNS thread pool: UV_THREADPOOL_SIZE=${parsed}` };
};

export default { describeThreadPool, RECOMMENDED_THREADS };
