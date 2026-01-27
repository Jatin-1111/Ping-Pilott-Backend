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
            enum: ['free', 'starter_monthly', 'starter_yearly', 'pro_monthly', 'pro_yearly', 'business_monthly', 'business_yearly', 'admin'],
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
                    if (this.role === 'admin') return -1;
                    const plan = this.subscription?.plan || 'free';
                    if (plan.startsWith('business')) return 100;
                    if (plan.startsWith('pro')) return 30;
                    if (plan.startsWith('starter')) return 10;
                    return 1; // Free
                }
            },
            minCheckFrequency: {
                type: Number,
                default: function () {
                    if (this.role === 'admin') return 1;
                    const plan = this.subscription?.plan || 'free';
                    if (plan.startsWith('business')) return 1; // 30s not supported by schema yet, sticking to 1m
                    if (plan.startsWith('pro')) return 1;
                    if (plan.startsWith('starter')) return 3;
                    return 5; // Free
                }
            },
            maxCheckFrequency: {
                type: Number,
                default: function () {
                    if (this.role === 'admin') return -1;
                    return 60;
                }
            },
            advancedAlerts: {
                type: Boolean,
                default: function () {
                    if (this.role === 'admin') return true;
                    const plan = this.subscription?.plan || 'free';
                    return !plan.startsWith('starter') && plan !== 'free'; // Pro and Business have advanced alerts
                }
            },
            apiAccess: {
                type: Boolean,
                default: function () {
                    if (this.role === 'admin') return true;
                    const plan = this.subscription?.plan || 'free';
                    return plan.startsWith('business');
                }
            },
            prioritySupport: {
                type: Boolean,
                default: function () {
                    if (this.role === 'admin') return true;
                    const plan = this.subscription?.plan || 'free';
                    return plan.startsWith('business') || plan.startsWith('pro');
                }
            },
            webhookIntegrations: {
                type: Boolean,
                default: function () {
                    if (this.role === 'admin') return true;
                    const plan = this.subscription?.plan || 'free';
                    return plan.startsWith('business');
                }
            },
            historicalReporting: {
                type: Boolean,
                default: function () {
                    if (this.role === 'admin') return true;
                    const plan = this.subscription?.plan || 'free';
                    return plan !== 'free';
                }
            },
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
        this.subscription.plan = 'admin';
        this.subscription.status = 'unlimited';
        this.subscription.features.maxServers = -1;
        this.subscription.features.minCheckFrequency = 1;
        this.subscription.features.maxCheckFrequency = -1;
        this.subscription.features.advancedAlerts = true;
        this.subscription.features.apiAccess = true;
        this.subscription.features.prioritySupport = true;
        this.subscription.features.webhookIntegrations = true;
        this.subscription.features.historicalReporting = true;
        this.subscription.features.unlimitedMonitoring = true;
    }
    // Logic to enforce plan limits on save for non-admins could go here if we wanted strong consistency
    // based on the plan string.
    else if (this.isModified('subscription.plan')) {
        const plan = this.subscription.plan;
        if (plan.startsWith('business')) {
            this.subscription.features.maxServers = 100;
            this.subscription.features.minCheckFrequency = 1;
            this.subscription.features.advancedAlerts = true;
            this.subscription.features.apiAccess = true;
            this.subscription.features.prioritySupport = true;
            this.subscription.features.webhookIntegrations = true;
            this.subscription.features.historicalReporting = true;
        } else if (plan.startsWith('pro')) {
            this.subscription.features.maxServers = 30;
            this.subscription.features.minCheckFrequency = 1;
            this.subscription.features.advancedAlerts = true;
            this.subscription.features.apiAccess = false;
            this.subscription.features.prioritySupport = true;
            this.subscription.features.webhookIntegrations = false;
            this.subscription.features.historicalReporting = true;
        } else if (plan.startsWith('starter')) {
            this.subscription.features.maxServers = 10;
            this.subscription.features.minCheckFrequency = 3;
            this.subscription.features.advancedAlerts = false;
            this.subscription.features.apiAccess = false;
            this.subscription.features.prioritySupport = false;
            this.subscription.features.webhookIntegrations = false;
            this.subscription.features.historicalReporting = true;
        } else if (plan === 'free') {
            this.subscription.features.maxServers = 1;
            this.subscription.features.minCheckFrequency = 5;
            this.subscription.features.advancedAlerts = false;
            this.subscription.features.apiAccess = false;
            this.subscription.features.prioritySupport = false;
            this.subscription.features.webhookIntegrations = false;
            this.subscription.features.historicalReporting = false;
        }
    }
    next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.hasActiveSubscription = function () {
    if (this.role === 'admin' || this.subscription.plan === 'admin') {
        return true;
    }
    const now = Date.now();
    return this.subscription.status === 'active' &&
        (this.subscription.endDate === null || this.subscription.endDate > now);
};

userSchema.methods.hasUnlimitedServers = function () {
    return this.role === 'admin' || this.subscription.features.maxServers === -1;
};

userSchema.methods.getMaxServers = function () {
    if (this.hasUnlimitedServers()) {
        return Number.MAX_SAFE_INTEGER;
    }
    return this.subscription.features.maxServers;
};

userSchema.methods.canAddMoreServers = async function (currentCount) {
    if (this.hasUnlimitedServers()) {
        return true;
    }
    return currentCount < this.subscription.features.maxServers;
};

userSchema.methods.getMinCheckFrequency = function () {
    return this.subscription.features.minCheckFrequency;
};

userSchema.methods.getMaxCheckFrequency = function () {
    if (this.role === 'admin' && this.subscription.features.maxCheckFrequency === -1) {
        return Number.MAX_SAFE_INTEGER;
    }
    return this.subscription.features.maxCheckFrequency;
};

const User = mongoose.model('User', userSchema);
export default User;