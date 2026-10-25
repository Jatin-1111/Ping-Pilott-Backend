// models/ServerCheck.js - Standardized (UTC)

import mongoose from 'mongoose';
import { MAX_RETENTION_DAYS } from '../utils/retention.js';

const serverCheckSchema = new mongoose.Schema({
    serverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Server',
        required: [true, 'Server ID is required'],
        index: true
    },
    status: {
        type: String,
        enum: ['up', 'down', 'unknown'],
        required: [true, 'Status is required']
    },
    responseTime: {
        type: Number,
        default: null
    },
    error: {
        type: String,
        default: null
    },
    // Why a failed check failed (utils/failures.js: dns, refused, reset, timeout, unreachable, tls, http, blocked,
    // invalid, other), and the HTTP status the server answered with, when it did. Older rows have neither.
    failureKind: String,
    statusCode: Number,
    // How much of responseTime was the server's own time (time to first byte minus the connect: utils/timings.js).
    // The rest is the network's. Only HTTP checks that answered have it; older rows do not.
    serverTime: Number,
    // Where the response time went, in ms (utils/requestTiming.js). A TCP check has dns and connect only. A failed check
    // has the steps it got through, and the one it stopped in as far as it had run. Older rows have none.
    timings: {
        dns: Number,
        connect: Number,
        tls: Number,
        ttfb: Number,
        redirects: Number
    },
    // Which step a failed check stopped in (utils/failurePhase.js: dns, connect, tls, response, content), and what the
    // server said (utils/evidence.js). Only failed checks have them; their `timings` are the steps that finished.
    failedPhase: String,
    evidence: {
        statusCode: Number,
        headers: mongoose.Schema.Types.Mixed,
        address: String,
        snippet: String,
        snippetTruncated: Boolean
    },
    // True when this check was slow while the checking process's own event loop was stalled, so the time is not
    // trusted: it is shown, but never counted toward a slow alert (services/loadMonitor.js). Absent otherwise.
    loadSuspect: Boolean,
    timestamp: {
        type: Date,
        default: Date.now
    },
    // Optional: useful for simple manual checks vs automated ones
    checkType: {
        type: String,
        default: 'automated'
    }
}, {
    timeseries: {
        timeField: 'timestamp',
        metaField: 'serverId',
        granularity: 'minutes'
    },
    // How long MongoDB keeps a check. For a time-series collection this is a collection option, set when it is created
    // (Mongoose passes it to createCollection). It cannot be an index: a TTL index on the time field is not accepted
    // here, so the index that used to be declared below never existed. A collection created earlier has to be changed
    // once with scripts/setRetentionTtl.js.
    expireAfterSeconds: MAX_RETENTION_DAYS * 24 * 60 * 60
});

// Create compound indexes for efficient querying
serverCheckSchema.index({ serverId: 1, timestamp: -1 });

// Additional indexes for optimized queries
serverCheckSchema.index({ serverId: 1, status: 1, timestamp: -1 }); // For status-filtered queries
serverCheckSchema.index({ timestamp: 1, status: 1 }); // For global status aggregations

// The 30 day TTL above is a backstop only: the nightly job in tasks/dataRetention.js deletes checks older than
// CHECK_DATA_RETENTION_DAYS (default 30, at most 30, which is why). scripts/checkRetention.js shows the state.

// Create and export the model
// Create and export the model
// Optimization: Enabled Time Series for massive performance gains (Requires MongoDB 5.0+)
const ServerCheck = mongoose.model('ServerCheck', serverCheckSchema);
export default ServerCheck;