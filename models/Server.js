import mongoose from 'mongoose';
import { isValidTimezone } from '../utils/schedule.js';

// Define a schema for the time window
const timeWindowSchema = new mongoose.Schema({
    start: {
        type: String,
        required: true,
        match: [/^([01]\d|2[0-3]):([0-5]\d)$/, 'Time must be in format HH:MM']
    },
    end: {
        type: String,
        required: true,
        match: [/^([01]\d|2[0-3]):([0-5]\d)$/, 'Time must be in format HH:MM']
    }
}, { _id: false });

// Define a schema for alert settings
const alertsSchema = new mongoose.Schema({
    enabled: {
        type: Boolean,
        default: false
    },
    email: {
        type: Boolean,
        default: false
    },
    phone: {
        type: Boolean,
        default: false
    },
    webhookUrl: {
        type: String,
        trim: true,
        match: [/^https?:\/\/.+$/, 'Invalid URL format']
    },
    responseThreshold: {
        type: Number,
        default: 1000,
        min: [100, 'Threshold must be at least 100ms']
    },
    timeWindow: {
        type: timeWindowSchema,
        default: () => ({ start: '00:00', end: '23:59' })
    }
}, { _id: false });

// Define a schema for monitoring settings
const monitoringSchema = new mongoose.Schema({
    frequency: {
        type: Number,
        default: 5,
        min: [1, 'Frequency must be at least 1 minute']
    },
    daysOfWeek: {
        type: [Number],
        default: [0, 1, 2, 3, 4, 5, 6], // Monday through Sunday
        validate: {
            validator: function (days) {
                return days.every(day => day >= 0 && day <= 6);
            },
            message: 'Days must be between 0 (Sunday) and 6 (Saturday)'
        }
    },
    timeWindows: {
        type: [timeWindowSchema],
        default: () => [{ start: '00:00', end: '23:59' }]
    },
    alerts: {
        type: alertsSchema,
        default: () => ({})
    },
    trialEndsAt: {
        type: Date,
        default: null
    }
}, { _id: false });

// Main server schema
const serverSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Server name is required'],
        trim: true
    },
    url: {
        type: String,
        required: [true, 'URL is required'],
        trim: true
    },
    type: {
        type: String,
        enum: ['website', 'api', 'tcp', 'database'],
        default: 'website'
    },
    description: {
        type: String,
        trim: true
    },
    // IANA timezone ("Asia/Kolkata") that this server's check days/hours and alert hours are read in.
    // Servers created before this field existed fall back to the TIMEZONE setting (see utils/schedule.js).
    timezone: {
        type: String,
        trim: true,
        validate: {
            validator: isValidTimezone,
            message: 'Unknown timezone'
        }
    },
    uploadedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: [true, 'User ID is required']
    },
    uploadedAt: {
        type: Date,
        default: Date.now
    },
    uploadedRole: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user'
    },
    uploadedPlan: {
        type: String,
        default: 'free'
    },
    priority: {
        type: String,
        enum: ['high', 'medium', 'low'],
        default: 'medium'
    },
    status: {
        type: String,
        enum: ['up', 'down', 'unknown'],
        default: 'unknown'
    },
    lastChecked: {
        type: Date,
        default: null
    },
    lastStatusChange: {
        type: Date,
        default: null
    },
    // When the scheduler should dispatch the next check. Set at dispatch time to (tick + frequency),
    // so the interval does not drift by the time each check takes. null/missing = due now.
    nextCheckAt: {
        type: Date,
        default: null
    },
    // Set when monitoring was stopped because the free trial ended (services/trialPause.js). A paused server is not
    // checked, shows as "unknown", and has no open incident. Cleared when the owner moves to a paid plan.
    pausedAt: {
        type: Date,
        default: null
    },
    // When the owner was emailed that the trial ended, so they are told once
    trialNoticeSentAt: {
        type: Date,
        default: null
    },
    // True while a "slow response" alert is open, so a slow streak sends one alert instead of one per check
    slowAlerted: {
        type: Boolean,
        default: false
    },
    // Scheduled checks in a row that were over the threshold (slowStreak) or back under it (fastStreak). A slow alert
    // opens after several slow ones and closes after a few quick ones (utils/alertDecision.js). Missing means 0.
    slowStreak: {
        type: Number,
        default: 0
    },
    fastStreak: {
        type: Number,
        default: 0
    },
    responseTime: {
        type: Number,
        default: null
    },
    error: {
        type: String,
        default: null
    },
    // The kind of failure behind `error` (utils/failures.js); null while the server is up
    failureKind: {
        type: String,
        default: null
    },
    monitoring: {
        type: monitoringSchema,
        default: () => ({})
    },
    contactEmails: {
        type: [String],
        default: [],
        validate: {
            validator: function (emails) {
                // Simple regex for email validation
                const emailRegex = /^\S+@\S+\.\S+$/;
                return emails.every(email => emailRegex.test(email));
            },
            message: 'Invalid email format'
        }
    },
    contactPhones: {
        type: [String],
        default: [],
        validate: {
            validator: function (phones) {
                // Digits only, 10 to 15 (country code allowed)
                const phoneRegex = /^\d{10,15}$/;
                return phones.every(phone => phoneRegex.test(phone));
            },
            message: 'Invalid phone format (must be 10 to 15 digits)'
        }
    }
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Create indexes for better performance
serverSchema.index({ uploadedBy: 1 });
serverSchema.index({ status: 1 });
serverSchema.index({ lastChecked: 1 });
serverSchema.index({ nextCheckAt: 1 });
// Finding free trials that have ended and not been paused yet
serverSchema.index({ pausedAt: 1, 'monitoring.trialEndsAt': 1 });
serverSchema.index({ uploadedAt: -1 });
// Compound index for check scheduler (find by status + sort by lastChecked/calc)
serverSchema.index({ status: 1, lastChecked: 1 });

// Create and export the model
const Server = mongoose.model('Server', serverSchema);
export default Server;