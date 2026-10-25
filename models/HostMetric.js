// models/HostMetric.js - one snapshot of a host, as its agent sent it (utils/hostMetrics.js checks it first)
//
// Raw points are kept for 24 hours; longer ranges read the 5-minute averages (models/HostMetric5m.js, added with the
// charts). A time-series collection like ServerCheck: its expiry is a collection option set when it is created, so a
// collection that already exists has to be changed once if this number changes.

import mongoose from 'mongoose';

export const RAW_RETENTION_SECONDS = 24 * 60 * 60;

const hostMetricSchema = new mongoose.Schema({
    serverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Server', required: true },
    timestamp: { type: Date, required: true },
    // CPU busy, 0 to 100, over the agent's sampling period, and the number of cores it is shared by
    cpu: { type: Number, required: true },
    cores: Number,
    load1: Number,
    load5: Number,
    load15: Number,
    memTotal: { type: Number, required: true },
    memUsed: { type: Number, required: true },
    swapTotal: Number,
    swapUsed: Number,
    disks: [{ _id: false, mount: String, total: Number, used: Number }],
    // Bytes per second over the sampling period, in and out of the machine
    rxBps: Number,
    txBps: Number,
    uptimeSec: Number,
    // The busiest processes by name only: never command lines, which hold passwords and keys
    procs: [{ _id: false, name: String, cpu: Number, mem: Number }]
}, {
    timeseries: { timeField: 'timestamp', metaField: 'serverId', granularity: 'minutes' },
    expireAfterSeconds: RAW_RETENTION_SECONDS
});

// One server's points, newest first (the page's charts); and every server's points in a time range (the 5-minute rollup)
hostMetricSchema.index({ serverId: 1, timestamp: -1 });
hostMetricSchema.index({ timestamp: 1 });

const HostMetric = mongoose.model('HostMetric', hostMetricSchema);
export default HostMetric;
