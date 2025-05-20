// models/CronJob.js - With date handling fixes

import mongoose from 'mongoose';

const cronJobSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Job name is required'],
        index: true
    },
    status: {
        type: String,
        enum: ['pending', 'running', 'completed', 'failed', 'skipped'],
        default: 'pending'
    },
    timezone: {
        type: String,
        default: 'Asia/Kolkata', // Default to Indian timezone
        required: true
    },
    startedAt: {
        type: Date,
        required: [true, 'Start time is required'],
        index: true,
        // Force to current date if a string is provided
        set: function (val) {
            return val instanceof Date ? val : new Date();
        }
    },
    completedAt: {
        type: Date,
        default: null,
        // Force to current date if a string is provided
        set: function (val) {
            return val instanceof Date ? val : val ? new Date() : null;
        }
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

// Pre-save hook to ensure dates are valid
cronJobSchema.methods.getLocalStartTime = function () {
    return moment(this.startedAt).tz(this.timezone).format();
};

cronJobSchema.methods.getLocalCompletedTime = function () {
    return this.completedAt ? moment(this.completedAt).tz(this.timezone).format() : null;
};

// Create indexes for better performance
cronJobSchema.index({ name: 1, startedAt: -1 });
cronJobSchema.index({ status: 1 });

// Create and export the model
const CronJob = mongoose.model('CronJob', cronJobSchema);
export default CronJob;