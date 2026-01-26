// models/ServerCheck.js - Standardized (UTC)

import mongoose from 'mongoose';

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
    }
});

// Create compound indexes for efficient querying
serverCheckSchema.index({ serverId: 1, timestamp: -1 });

// TTL Index: expire documents after 30 days (2592000 seconds)
serverCheckSchema.index({ timestamp: 1 }, { expireAfterSeconds: 2592000 });

// Create and export the model
// Create and export the model
// Optimization: Enabled Time Series for massive performance gains (Requires MongoDB 5.0+)
const ServerCheck = mongoose.model('ServerCheck', serverCheckSchema);
export default ServerCheck;