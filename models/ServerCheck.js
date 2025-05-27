// models/ServerCheck.js - IST TIMEZONE ONLY 🇮🇳

import mongoose from 'mongoose';
import moment from 'moment-timezone';

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
        default: 'Asia/Kolkata', // ALWAYS IST
        required: true
    },
    // IST timezone-specific fields for faster querying
    localDate: {
        type: String, // Store as YYYY-MM-DD in IST
        required: true
    },
    localHour: {
        type: Number, // 0-23 in IST
        required: true
    },
    localMinute: {
        type: Number, // 0-59 in IST
        required: true
    },
    timeSlot: {
        type: Number, // 0-3 for 15-minute slots
        required: true,
        index: true
    }
});

// FIXED: Calculate IST timezone fields before saving
serverCheckSchema.pre('save', function (next) {
    if (this.isNew || this.isModified('timestamp') || this.isModified('timezone')) {
        // FORCE IST timezone
        this.timezone = 'Asia/Kolkata';

        // Calculate IST fields from timestamp
        const istMoment = moment(this.timestamp).tz('Asia/Kolkata');

        this.localDate = istMoment.format('YYYY-MM-DD');
        this.localHour = istMoment.hour();
        this.localMinute = istMoment.minute();
        this.timeSlot = Math.floor(istMoment.minute() / 15); // 0-3 for 15-minute slots
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