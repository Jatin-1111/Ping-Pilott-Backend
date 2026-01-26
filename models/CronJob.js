// models/CronJob.js - Simplified System Time Version

import mongoose from 'mongoose';

const cronJobSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Job name is required']
    },
    status: {
        type: String,
        enum: ['pending', 'running', 'completed', 'failed', 'skipped'],
        default: 'pending'
    },
    startedAt: {
        type: Date,
        required: [true, 'Start time is required']
    },
    completedAt: {
        type: Date,
        default: null
    },
    duration: {
        type: Number, // In milliseconds
        get: function () {
            if (!this.completedAt) return null;
            return new Date(this.completedAt) - new Date(this.startedAt);
        }
    },
    result: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    error: {
        type: String,
        default: null
    }
}, {
    timestamps: true,
    toJSON: { virtuals: true, getters: true },
    toObject: { virtuals: true, getters: true }
});

// Method to get duration in human readable format
cronJobSchema.methods.getDurationFormatted = function () {
    if (!this.completedAt) return 'Running...';

    const duration = this.duration;
    if (duration < 1000) return `${duration}ms`;
    if (duration < 60000) return `${(duration / 1000).toFixed(1)}s`;
    return `${(duration / 60000).toFixed(1)}m`;
};

// Static method to find recent jobs (last N hours)
cronJobSchema.statics.findRecent = function (hoursBack = 24, additionalFilters = {}) {
    const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

    const filter = {
        startedAt: { $gte: cutoffTime },
        ...additionalFilters
    };

    return this.find(filter).sort({ startedAt: -1 });
};

// Static method to cleanup old jobs
cronJobSchema.statics.cleanupOld = function (daysOld = 30) {
    const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
    return this.deleteMany({
        startedAt: { $lt: cutoffDate }
    });
};

// Static method to get job statistics
cronJobSchema.statics.getStats = async function (hoursBack = 24) {
    const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

    const pipeline = [
        {
            $match: {
                startedAt: { $gte: cutoffTime }
            }
        },
        {
            $group: {
                _id: '$status',
                count: { $sum: 1 },
                avgDuration: { $avg: '$duration' }
            }
        }
    ];

    const results = await this.aggregate(pipeline);

    // Format results
    const stats = {
        total: 0,
        completed: 0,
        failed: 0,
        running: 0,
        skipped: 0,
        avgDuration: 0
    };

    results.forEach(result => {
        stats.total += result.count;
        stats[result._id] = result.count;
        if (result._id === 'completed') {
            stats.avgDuration = Math.round(result.avgDuration || 0);
        }
    });

    return stats;
};

// Create simple indexes
cronJobSchema.index({ name: 1, startedAt: -1 });
cronJobSchema.index({ status: 1, startedAt: -1 });
cronJobSchema.index({ startedAt: -1 });

// Create and export the model
const CronJob = mongoose.model('CronJob', cronJobSchema);
export default CronJob;