import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
    email: {
        type: String,
        required: [true, 'Email is required'],
        unique: true,
        lowercase: true,
        trim: true,
        match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address']
    },
    password: {
        type: String,
        required: [true, 'Password is required'],
        minlength: [6, 'Password must be at least 6 characters'],
        select: false // Don't return password in queries by default
    },
    displayName: {
        type: String,
        trim: true
    },
    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user'
    },
    emailVerified: {
        type: Boolean,
        default: false
    },
    verificationToken: String,
    verificationTokenExpiry: Date,
    resetToken: String,
    resetTokenExpiry: Date,
    photoURL: String,
    subscription: {
        plan: {
            type: String,
            enum: ['free', 'monthly', 'halfYearly', 'yearly', 'admin'],
            default: 'free'
        },
        startDate: Date,
        endDate: Date,
        status: {
            type: String,
            enum: ['trial', 'active', 'expired', 'cancelled'],
            default: 'trial'
        },
        paymentId: String,
        features: {
            maxServers: {
                type: Number,
                default: 1
            },
            minCheckFrequency: {
                type: Number,
                default: 5
            },
            maxCheckFrequency: {
                type: Number,
                default: 30
            },
            advancedAlerts: {
                type: Boolean,
                default: false
            },
            apiAccess: {
                type: Boolean,
                default: false
            },
            prioritySupport: {
                type: Boolean,
                default: false
            },
            webhookIntegrations: {
                type: Boolean,
                default: false
            },
            historicalReporting: {
                type: Boolean,
                default: false
            }
        }
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function (next) {
    // Only hash the password if it's modified or new
    if (!this.isModified('password')) return next();

    try {
        const salt = await bcrypt.genSalt(12);
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (error) {
        next(error);
    }
});

// Method to compare passwords
userSchema.methods.comparePassword = async function (candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

// Method to check if subscription is active
userSchema.methods.hasActiveSubscription = function () {
    // Admin plan is always active
    if (this.subscription.plan === 'admin') {
        return true;
    }

    // Check if subscription has expired
    const now = Date.now();
    return this.subscription.status === 'active' &&
        (this.subscription.endDate === null || this.subscription.endDate > now);
};

// Create and export the model
const User = mongoose.model('User', userSchema);
export default User;