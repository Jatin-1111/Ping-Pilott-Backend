// models/AlertEvent.js - one row per alert actually delivered
//
// The admin dashboard used to show "alerts sent" by counting servers that happened to be down right now,
// because nothing recorded alerts. This is the record: written by the alert worker after delivery.

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
        enum: ['server_down', 'server_recovery', 'slow_response'],
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

alertEventSchema.index({ createdAt: -1, type: 1 });
// History for the admin charts; older rows are of no use and would only grow the collection
alertEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const AlertEvent = mongoose.model('AlertEvent', alertEventSchema);
export default AlertEvent;
