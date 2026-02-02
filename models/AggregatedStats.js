// models/AggregatedStats.js - Aggregated statistics for long-term data retention

import mongoose from 'mongoose';

const hourlyStatsSchema = new mongoose.Schema({
    hour: {
        type: Number,
        required: true,
        min: 0,
        max: 23
    },
    avgResponseTime: {
        type: Number,
        default: 0
    },
    uptime: {
        type: Number,
        default: 0
    },
    downtime: {
        type: Number,
        default: 0
    },
    totalChecks: {
        type: Number,
        default: 0
    },
    uptimePercentage: {
        type: Number,
        default: 100
    }
}, { _id: false });

const aggregatedStatsSchema = new mongoose.Schema({
    serverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Server',
        required: true,
        index: true
    },
    date: {
        type: Date,
        required: true,
        index: true
    },
    hourlyStats: [hourlyStatsSchema],
    dailySummary: {
        avgResponseTime: Number,
        uptimePercentage: Number,
        totalChecks: Number,
        totalDowntime: Number
    }
}, {
    timestamps: true
});

// Compound index for efficient querying
aggregatedStatsSchema.index({ serverId: 1, date: -1 });

// TTL Index: expire documents after 90 days (7776000 seconds)
aggregatedStatsSchema.index({ date: 1 }, { expireAfterSeconds: 7776000 });

const AggregatedStats = mongoose.model('AggregatedStats', aggregatedStatsSchema);
export default AggregatedStats;
