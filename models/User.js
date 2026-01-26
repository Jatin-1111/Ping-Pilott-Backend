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
    subscription: {
        plan: {
            type: String,
            enum: ['free', 'monthly', 'halfYearly', 'yearly', 'admin'],
            default: function () {
                // Set default subscription plan based on role
                return this.role === 'admin' ? 'admin' : 'free';
            }
        },
        startDate: Date,
        endDate: Date,
        status: {
            type: String,
            enum: ['trial', 'active', 'expired', 'cancelled', 'unlimited'],
            default: function () {
                // Set default status based on role
                return this.role === 'admin' ? 'unlimited' : 'trial';
            }
        },
        paymentId: String,
        features: {
            maxServers: {
                type: Number,
                default: function () {
                    // Unlimited servers for admin (using -1 to represent unlimited)
                    return this.role === 'admin' ? -1 : 1;
                }
            },
            minCheckFrequency: {
                type: Number,
                default: function () {
                    // Admins can set check frequency as low as 1 minute
                    return this.role === 'admin' ? 1 : 5;
                }
            },
            maxCheckFrequency: {
                type: Number,
                default: function () {
                    // Admins have no upper limit for check frequency
                    return this.role === 'admin' ? -1 : 30;
                }
            },
            advancedAlerts: {
                type: Boolean,
                default: function () {
                    return this.role === 'admin';
                }
            },
            apiAccess: {
                type: Boolean,
                default: function () {
                    return this.role === 'admin';
                }
            },
            prioritySupport: {
                type: Boolean,
                default: function () {
                    return this.role === 'admin';
                }
            },
            webhookIntegrations: {
                type: Boolean,
                default: function () {
                    return this.role === 'admin';
                }
            },
            historicalReporting: {
                type: Boolean,
                default: function () {
                    return this.role === 'admin';
                }
            },
            // New field for admin unlimited monitoring duration
            unlimitedMonitoring: {
                type: Boolean,
                default: function () {
                    return this.role === 'admin';
                }
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
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
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

// Ensure admin settings are always properly set
userSchema.pre('save', function (next) {
    if (this.role === 'admin') {
        // Ensure admin subscription is always set correctly
        this.subscription.plan = 'admin';
        this.subscription.status = 'unlimited';
        this.subscription.features.maxServers = -1; // -1 represents unlimited
        this.subscription.features.minCheckFrequency = 1;
        this.subscription.features.maxCheckFrequency = -1; // -1 represents no upper limit
        this.subscription.features.advancedAlerts = true;
        this.subscription.features.apiAccess = true;
        this.subscription.features.prioritySupport = true;
        this.subscription.features.webhookIntegrations = true;
        this.subscription.features.historicalReporting = true;
        this.subscription.features.unlimitedMonitoring = true;
    }
    next();
});

// Method to compare passwords
userSchema.methods.comparePassword = async function (candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

// Method to check if subscription is active
userSchema.methods.hasActiveSubscription = function () {
    // Admin plan is always active with unlimited privileges
    if (this.role === 'admin' || this.subscription.plan === 'admin') {
        return true;
    }

    // Check if subscription has expired
    const now = Date.now();
    return this.subscription.status === 'active' &&
        (this.subscription.endDate === null || this.subscription.endDate > now);
};

// Add a method to check if a user has unlimited servers
userSchema.methods.hasUnlimitedServers = function () {
    return this.role === 'admin' || this.subscription.features.maxServers === -1;
};

// Add a method to get the maximum number of servers
userSchema.methods.getMaxServers = function () {
    if (this.hasUnlimitedServers()) {
        return Number.MAX_SAFE_INTEGER; // Effectively unlimited
    }
    return this.subscription.features.maxServers;
};

// Method to check if the user can add more servers
userSchema.methods.canAddMoreServers = async function (currentCount) {
    if (this.hasUnlimitedServers()) {
        return true;
    }
    return currentCount < this.subscription.features.maxServers;
};

// Method to get min check frequency (in minutes)
userSchema.methods.getMinCheckFrequency = function () {
    return this.subscription.features.minCheckFrequency;
};

// Method to get max check frequency (in minutes)
userSchema.methods.getMaxCheckFrequency = function () {
    if (this.role === 'admin' && this.subscription.features.maxCheckFrequency === -1) {
        return Number.MAX_SAFE_INTEGER; // No practical upper limit
    }
    return this.subscription.features.maxCheckFrequency;
};

// Create and export the model
const User = mongoose.model('User', userSchema);
export default User;