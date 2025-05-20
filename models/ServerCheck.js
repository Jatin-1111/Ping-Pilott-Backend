import mongoose from 'mongoose';
import moment from 'moment-timezone'; // Add missing import

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
        default: Date.now,
        index: true
    },
    timezone: {
        type: String,
        default: 'Asia/Kolkata',
        required: true
    },
    // These timezone-specific fields help with faster querying
    localDate: {
        type: String, // Store as YYYY-MM-DD in server's timezone
        required: true
    },
    localHour: {
        type: Number, // 0-23 in server's timezone
        required: true
    },
    localMinute: {
        type: Number, // 0-59 in server's timezone
        required: true
    },
    timeSlot: {
        type: Number, // 0-3 for 15-minute slots
        required: true,
        index: true
    }
});

// Fix: Properly calculate timezone-specific fields before saving
serverCheckSchema.pre('save', function (next) {
    if (this.isNew || this.isModified('timestamp') || this.isModified('timezone')) {
        const m = moment(this.timestamp).tz(this.timezone);
        this.localDate = m.format('YYYY-MM-DD');
        this.localHour = m.hour();
        this.localMinute = m.minute();
        this.timeSlot = Math.floor(m.minute() / 15); // 0-3 for 15-minute slots
    }
    next();
});

// Create compound indexes for efficient querying
serverCheckSchema.index({ serverId: 1, localDate: 1 });
serverCheckSchema.index({ serverId: 1, timestamp: -1 });
serverCheckSchema.index({ localDate: 1, localHour: 1 });

// Create and export the model
const ServerCheck = mongoose.model('ServerCheck', serverCheckSchema);
export default ServerCheck;