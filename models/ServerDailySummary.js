import mongoose from 'mongoose';

const serverDailySummarySchema = new mongoose.Schema({
    serverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Server',
        required: [true, 'Server ID is required'],
        index: true
    },
    date: {
        type: String, // YYYY-MM-DD format
        required: [true, 'Date is required'],
        index: true
    },
    totalChecks: {
        type: Number,
        required: [true, 'Total checks is required'],
        min: 0
    },
    upChecks: {
        type: Number,
        required: [true, 'Up checks is required'],
        min: 0
    },
    uptime: {
        type: Number, // Percentage (0-100)
        required: [true, 'Uptime is required'],
        min: 0,
        max: 100
    },
    avgResponseTime: {
        type: Number,
        default: null
    },
    maxResponseTime: {
        type: Number,
        default: null
    },
    minResponseTime: {
        type: Number,
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Create compound index for efficient querying
serverDailySummarySchema.index({ serverId: 1, date: 1 }, { unique: true });

// Create and export the model
const ServerDailySummary = mongoose.model('ServerDailySummary', serverDailySummarySchema);
export default ServerDailySummary;