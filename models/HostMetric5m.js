// models/HostMetric5m.js - one server's host metrics for one 5-minute stretch, rolled up from raw snapshots
//
// Written by tasks/hostRollup.js from models/HostMetric.js (utils/hostSeries.js does the arithmetic) and kept for 30 days.
// An ordinary collection, not a time-series one: the job writes a row again whenever a late snapshot lands in its bucket,
// and only an ordinary collection can update a row in place. The unique index makes that rewrite safe to repeat.

import mongoose from 'mongoose';

export const ROLLUP_RETENTION_SECONDS = 30 * 24 * 60 * 60;

const hostMetric5mSchema = new mongoose.Schema({
    serverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Server', required: true },
    // the start of the 5-minute stretch
    bucket: { type: Date, required: true },
    // how many snapshots it was made from
    n: { type: Number, required: true },
    cpu: Number,
    cpuMax: Number,
    memPct: Number,
    memPctMax: Number,
    swapPct: Number,
    load1: Number,
    rxBps: Number,
    txBps: Number,
    // each disk at its fullest in the stretch
    disks: [{ _id: false, mount: String, total: Number, pct: Number }],
    memTotal: Number,
    uptimeSec: Number
});

// A server's rows in time order; and the rewrite of a bucket
hostMetric5mSchema.index({ serverId: 1, bucket: 1 }, { unique: true });
hostMetric5mSchema.index({ bucket: 1 }, { expireAfterSeconds: ROLLUP_RETENTION_SECONDS });

const HostMetric5m = mongoose.model('HostMetric5m', hostMetric5mSchema);
export default HostMetric5m;
