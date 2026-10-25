// models/AlertEvent.js - one row per alert a user was told about
//
// The admin dashboard used to show "alerts sent" by counting servers that happened to be down right now,
// because nothing recorded alerts. This is the record: written by the alert worker once the alert has been handled.
//
// It is also the feed behind the mobile app's Alerts tab, so each row carries what the app needs to show it
// (server name, address, message) even if the server is later renamed or deleted.

import mongoose from 'mongoose';

const alertEventSchema = new mongoose.Schema({
    serverId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        index: true
    },
    type: {
        type: String,
        // The host_ types are for app versions that know them: the feed leaves them out unless asked (utils/alertFeed.js)
        enum: ['server_down', 'server_recovery', 'slow_response', 'host_cpu_high', 'host_memory_high', 'host_disk_high', 'host_metrics_missing'],
        required: true
    },
    // Snapshot at the time of the alert. Older rows (written before the mobile app existed) don't have these.
    serverName: {
        type: String,
        trim: true
    },
    serverUrl: {
        type: String,
        trim: true
    },
    message: {
        type: String,
        trim: true
    },
    // Why a down alert's check failed (utils/failures.js) and the HTTP status the server answered with, when it did.
    // The feed turns them into the plain-words diagnosis when it is read (utils/diagnosis.js), so a change to the wording
    // reaches old alerts too. Rows written before these existed have neither.
    failureKind: String,
    statusCode: Number,
    // A host alert (utils/hostAlerts.js): which number it is about, and whether this is the end of it
    metric: String,
    recovered: Boolean,
    // null until the user has seen the alert in the app
    readAt: {
        type: Date,
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

alertEventSchema.index({ createdAt: -1, type: 1 });
// A user's feed, newest first, and the catch-up query "everything after this alert"
alertEventSchema.index({ userId: 1, _id: -1 });
// History for the admin charts; older rows are of no use and would only grow the collection
alertEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const AlertEvent = mongoose.model('AlertEvent', alertEventSchema);
export default AlertEvent;
