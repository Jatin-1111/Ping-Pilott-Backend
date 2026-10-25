// models/PendingAlert.js - an alert that has to reach its owner, kept until it has
//
// An alert used to exist only as a job in Redis. If Redis was unreachable at that moment, if it lost its data, or if
// the email provider was down for longer than the job's few retries, the alert was gone for good: the server was
// already saved as down, and a down -> down check never alerts again. This row is written when the status changes and
// is only marked delivered once every channel has succeeded, so anything left undelivered can be found and retried.
//
// Written by services/alertOutbox.js, processed by services/alertDelivery.js, re-queued by the reconciler cron.

import mongoose from 'mongoose';

const pendingAlertSchema = new mongoose.Schema({
    serverId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId
    },
    alertType: {
        type: String,
        // cert_expiring goes by email and webhook only: the in-app feed and the mobile app do not know it
        enum: ['server_down', 'server_recovery', 'slow_response', 'cert_expiring', 'host_cpu_high', 'host_memory_high', 'host_disk_high', 'host_metrics_missing'],
        required: true
    },
    oldStatus: String,
    newStatus: String,
    // 'high' or 'normal': the queue priority, kept so a re-queued alert keeps it
    priority: {
        type: String,
        default: 'normal'
    },
    // What the check reported: { status, responseTime, error, slow }
    checkResult: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    // Which parts have succeeded. A channel with nothing to send (no contacts, no webhook) counts as done.
    // A retry only repeats what is still false, so a failing webhook cannot cause a second email.
    done: {
        recorded: { type: Boolean, default: false }, // the in-app feed row (and its live push)
        email: { type: Boolean, default: false },
        webhook: { type: Boolean, default: false }
    },
    // Set when everything above is done (or the server no longer exists)
    deliveredAt: {
        type: Date,
        default: null
    },
    // Set when the alert is still undelivered after 24 hours and we stop trying
    abandonedAt: {
        type: Date,
        default: null
    },
    // null until a job for it has been queued, so "never queued" is easy to find
    lastQueuedAt: {
        type: Date,
        default: null
    },
    requeues: {
        type: Number,
        default: 0
    },
    lastError: {
        type: String,
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// What the reconciler looks for
pendingAlertSchema.index({ deliveredAt: 1, abandonedAt: 1, createdAt: 1 });
// Delivered and abandoned rows are of no use for long
pendingAlertSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

const PendingAlert = mongoose.model('PendingAlert', pendingAlertSchema);
export default PendingAlert;
