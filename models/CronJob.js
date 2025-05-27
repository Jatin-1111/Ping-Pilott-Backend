// models/CronJob.js - PURE IST TIMEZONE MODEL 🇮🇳

import mongoose from 'mongoose';
import moment from 'moment-timezone';

// PURE IST CONFIGURATION
const IST_TIMEZONE = 'Asia/Kolkata';

const cronJobSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Job name is required'],
        index: true
    },
    status: {
        type: String,
        enum: ['pending', 'running', 'completed', 'failed', 'skipped'],
        default: 'pending',
        index: true
    },
    timezone: {
        type: String,
        default: IST_TIMEZONE, // ALWAYS IST
        required: true
    },
    startedAt: {
        type: Date,
        required: [true, 'Start time is required'],
        index: true
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
    },
    // IST-specific fields for better querying and cleanup
    istDate: {
        type: String, // YYYY-MM-DD in IST
        required: true,
        index: true
    },
    istHour: {
        type: Number, // 0-23 in IST
        required: true
    },
    istStartTime: {
        type: String, // HH:mm:ss in IST
        required: true
    }
}, {
    timestamps: true,
    toJSON: { virtuals: true, getters: true },
    toObject: { virtuals: true, getters: true }
});

// Pre-save middleware to calculate IST fields
cronJobSchema.pre('save', function (next) {
    if (this.isNew || this.isModified('startedAt')) {
        // FORCE IST timezone
        this.timezone = IST_TIMEZONE;

        // Calculate IST fields
        const istMoment = moment(this.startedAt).tz(IST_TIMEZONE);
        this.istDate = istMoment.format('YYYY-MM-DD');
        this.istHour = istMoment.hour();
        this.istStartTime = istMoment.format('HH:mm:ss');

        console.log(`[IST DEBUG] CronJob ${this.name}: ${this.istDate} ${this.istStartTime} IST`);
    }
    next();
});

// Method to get IST formatted start time
cronJobSchema.methods.getISTStartTime = function () {
    return moment(this.startedAt).tz(IST_TIMEZONE).format('YYYY-MM-DD HH:mm:ss');
};

// Method to get IST formatted completion time
cronJobSchema.methods.getISTCompletedTime = function () {
    return this.completedAt ?
        moment(this.completedAt).tz(IST_TIMEZONE).format('YYYY-MM-DD HH:mm:ss') :
        null;
};

// Method to get duration in human readable format
cronJobSchema.methods.getDurationFormatted = function () {
    if (!this.completedAt) return 'Running...';

    const duration = this.duration;
    if (duration < 1000) return `${duration}ms`;
    if (duration < 60000) return `${(duration / 1000).toFixed(1)}s`;
    return `${(duration / 60000).toFixed(1)}m`;
};

// Static method to create with IST data
cronJobSchema.statics.createWithIST = async function (data) {
    const istMoment = moment().tz(IST_TIMEZONE);

    const jobData = {
        ...data,
        startedAt: new Date(),
        timezone: IST_TIMEZONE,
        istDate: istMoment.format('YYYY-MM-DD'),
        istHour: istMoment.hour(),
        istStartTime: istMoment.format('HH:mm:ss')
    };

    return this.create(jobData);
};

// Static method to find jobs by IST date
cronJobSchema.statics.findByISTDate = function (date, additionalFilters = {}) {
    const filter = {
        istDate: date, // YYYY-MM-DD format
        ...additionalFilters
    };

    return this.find(filter).sort({ startedAt: -1 });
};

// Static method to find recent jobs (last N hours in IST)
cronJobSchema.statics.findRecentIST = function (hoursBack = 24, additionalFilters = {}) {
    const cutoffTime = moment().tz(IST_TIMEZONE).subtract(hoursBack, 'hours').toDate();

    const filter = {
        startedAt: { $gte: cutoffTime },
        ...additionalFilters
    };

    return this.find(filter).sort({ startedAt: -1 });
};

// Static method to cleanup old jobs by IST date
cronJobSchema.statics.cleanupByISTDate = function (beforeDate) {
    return this.deleteMany({
        istDate: { $lt: beforeDate } // YYYY-MM-DD format
    });
};

// Static method to get job statistics for IST date range
cronJobSchema.statics.getISTStats = async function (startDate, endDate) {
    const pipeline = [
        {
            $match: {
                istDate: {
                    $gte: startDate,
                    $lte: endDate
                }
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

// Virtual for IST display
cronJobSchema.virtual('istDisplay').get(function () {
    return {
        date: this.istDate,
        startTime: this.istStartTime,
        completedTime: this.completedAt ?
            moment(this.completedAt).tz(IST_TIMEZONE).format('HH:mm:ss') : null,
        duration: this.getDurationFormatted(),
        timezone: this.timezone
    };
});

// Create indexes for better performance with IST queries
cronJobSchema.index({ name: 1, istDate: -1 });
cronJobSchema.index({ status: 1, istDate: -1 });
cronJobSchema.index({ startedAt: -1 });
cronJobSchema.index({ istDate: 1 }); // For cleanup operations

// Create and export the model
const CronJob = mongoose.model('CronJob', cronJobSchema);
export default CronJob;