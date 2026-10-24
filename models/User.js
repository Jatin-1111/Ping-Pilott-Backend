import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { userCache } from '../utils/userCache.js';
import logger from '../utils/logger.js';

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
    // A new address waiting to be confirmed. The account keeps working with the old one until then.
    pendingEmail: {
        type: String,
        lowercase: true,
        trim: true
    },
    // Set whenever the password changes; tokens issued before it are no longer accepted
    passwordChangedAt: Date,
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
    toJSON: {
        virtuals: true,
        // Everything that is sent to a client (login, /me, /users, admin lists, register...) goes through
        // here, so secrets can never leak by accident. Before, /register returned the email verification
        // token, which let anyone verify an address they did not own.
        transform: (doc, ret) => {
            delete ret.password;
            delete ret.verificationToken;
            delete ret.verificationTokenExpiry;
            delete ret.resetToken;
            delete ret.resetTokenExpiry;
            delete ret.passwordChangedAt;
            delete ret.__v;
            return ret;
        }
    },
    toObject: { virtuals: true }
});

// bcrypt work factor. Each step doubles the time a hash takes, and sign-in and sign-up pay it once.
// 10 is the lowest value current guidance accepts; 12 made both take over two seconds on a small server.
export const passwordRounds = () => Math.min(14, Math.max(10, parseInt(process.env.BCRYPT_ROUNDS, 10) || 10));

// Hash password before saving
userSchema.pre('save', async function (next) {
    if (!this.isModified('password')) return next();
    // (a brand new account has no earlier sessions to cut off)
    if (!this.isNew) this.passwordChangedAt = new Date();
    try {
        const salt = await bcrypt.genSalt(passwordRounds());
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

// Hashes made at a higher cost than we use now make every sign-in slow. After a successful sign-in, re-hash in
// the background at the current cost. It does not touch passwordChangedAt (no one is signed out), and it only
// writes if the stored hash is still the one we checked, so it can never overwrite a password change.
userSchema.methods.upgradePasswordHash = function (plainPassword) {
    const rounds = passwordRounds();
    const current = this.password;
    if (!current || bcrypt.getRounds(current) <= rounds) return;
    bcrypt
        .hash(plainPassword, rounds)
        .then((hash) => this.constructor.updateOne({ _id: this._id, password: current }, { $set: { password: hash } }))
        .catch((err) => logger.error(`Could not upgrade password hash: ${err.message}`));
};

// Keep the auth cache honest: any change to a user drops its cached copy
userSchema.post('save', function (doc) {
    userCache.invalidate(doc._id);
});
userSchema.post(['updateOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'deleteOne', 'updateMany', 'deleteMany'], function () {
    userCache.clear();
});

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