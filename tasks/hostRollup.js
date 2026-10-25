// tasks/hostRollup.js - rolls raw host snapshots into 5-minute rows (the arithmetic is utils/hostSeries.js)
//
// Every 5 minutes, a little after the boundary, the buckets that have finished are rolled up. The window reaches back four
// buckets, not one, because an agent that was offline sends its kept snapshots when it is back (up to 15 minutes old): they
// land in buckets already rolled, and rolling those again from the raw rows is what puts them in. Writing a bucket is an
// upsert of the whole row, so doing it twice, or two processes doing it at once, gives the same row.
// After a restart, or a gap in the schedule, `catchUpHostRollup` fills in what was missed, an hour at a time.

import HostMetric from '../models/HostMetric.js';
import HostMetric5m from '../models/HostMetric5m.js';
import { BUCKET_MS, bucketStart, rollupRows } from '../utils/hostSeries.js';
import { RAW_RETENTION_SECONDS } from '../models/HostMetric.js';
import logger from '../utils/logger.js';

export const LOOKBACK_BUCKETS = 4;
const CHUNK_MS = 60 * 60 * 1000;

const defaults = {
    readRaw: (from, to) => HostMetric.find({ timestamp: { $gte: from, $lt: to } }).select('-_id').lean(),
    upsertRows: (rows) => HostMetric5m.bulkWrite(rows.map((row) => ({
        updateOne: { filter: { serverId: row.serverId, bucket: row.bucket }, update: { $set: row }, upsert: true }
    })), { ordered: false }),
    newestRolled: async () => (await HostMetric5m.findOne().sort({ bucket: -1 }).select('bucket').lean())?.bucket ?? null,
    now: () => Date.now()
};

/** Roll up the raw snapshots in [from, to) and store the rows. Returns how many rows were written. */
async function rollRange(from, to, d) {
    const raw = await d.readRaw(new Date(from), new Date(to));
    const rows = rollupRows(raw);
    if (rows.length > 0) await d.upsertRows(rows);
    return rows.length;
}

/**
 * The regular run: the finished buckets of the last few. The bucket that is still filling is left alone.
 * @param {Object} [deps]  replaceable in tests
 * @returns {Promise<{ rows: number, from: Date, to: Date }>}
 */
export async function runHostRollup(deps = {}) {
    const d = { ...defaults, ...deps };
    const to = bucketStart(d.now());
    const from = to - LOOKBACK_BUCKETS * BUCKET_MS;
    const rows = await rollRange(from, to, d);
    return { rows, from: new Date(from), to: new Date(to) };
}

/**
 * Fill in what a restart or a gap missed: from the newest stored bucket (or as far back as raw snapshots are kept) up to
 * the last finished bucket, an hour at a time so a long gap is many small reads, not one huge one.
 * @returns {Promise<{ rows: number, chunks: number }>}
 */
export async function catchUpHostRollup(deps = {}) {
    const d = { ...defaults, ...deps };
    const now = d.now();
    const to = bucketStart(now);
    const oldest = now - RAW_RETENTION_SECONDS * 1000;
    const newest = await d.newestRolled();
    // the newest stored bucket may be partial if the process stopped inside it, so it is rolled again
    const start = Math.max(bucketStart(oldest), newest ? new Date(newest).getTime() : 0);

    let rows = 0;
    let chunks = 0;
    for (let from = start; from < to; from += CHUNK_MS) {
        rows += await rollRange(from, Math.min(from + CHUNK_MS, to), d);
        chunks += 1;
    }
    if (rows > 0) logger.info(`Host metrics caught up: ${rows} rows from ${chunks} chunk${chunks === 1 ? '' : 's'}`);
    return { rows, chunks };
}

export default { runHostRollup, catchUpHostRollup, LOOKBACK_BUCKETS };
