import mongoose from 'mongoose';

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
    responseThreshold: {
        type: Number,
        default: 1000,
        min: [100, 'Threshold must be at least 100ms']
    },
    timeWindow: {
        type: timeWindowSchema,
        default: () => ({ start: '09:00', end: '17:00' })
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
        default: [1, 2, 3, 4, 5], // Monday through Friday
        validate: {
            validator: function (days) {
                return days.every(day => day >= 0 && day <= 7);
            },
            message: 'Days must be between 0 (Sunday) and 7 (Sunday)'
        }
    },
    timeWindows: {
        type: [timeWindowSchema],
        default: () => [{ start: '09:00', end: '17:00' }]
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
    uploadedBy: {
        type: String,
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
    responseTime: {
        type: Number,
        default: null
    },
    error: {
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
                // Simple regex for phone numbers (10 digits)
                const phoneRegex = /^\d{10}$/;
                return phones.every(phone => phoneRegex.test(phone));
            },
            message: 'Invalid phone format (must be 10 digits)'
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
serverSchema.index({ uploadedAt: -1 });
// Compound index for check scheduler (find by status + sort by lastChecked/calc)
serverSchema.index({ status: 1, lastChecked: 1 });

// Calculate uptime percentage
serverSchema.virtual('uptime24h').get(function () {
    // This would normally be calculated from actual check history
    // For demonstration purposes, we return a fixed value
    return 99.8;
});

// Create and export the model
const Server = mongoose.model('Server', serverSchema);
export default Server;