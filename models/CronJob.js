import mongoose from 'mongoose';

const cronJobSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Job name is required'],
        index: true
    },
    status: {
        type: String,
        enum: ['pending', 'running', 'completed', 'failed'],
        default: 'pending'
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
            return this.completedAt - this.startedAt;
        },
        set: function (v) {
            return v; // This is a virtual property calculated on the fly
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

// Create indexes for better performance
cronJobSchema.index({ name: 1, startedAt: -1 });
cronJobSchema.index({ status: 1 });

// Create TTL index to automatically delete old records after 30 days
// cronJobSchema.index({ startedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// Create and export the model
const CronJob = mongoose.model('CronJob', cronJobSchema);
export default CronJob;