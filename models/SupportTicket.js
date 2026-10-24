// models/SupportTicket.js
import mongoose from 'mongoose';

const supportTicketSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: [true, 'User ID is required'],
        index: true
    },
    subject: {
        type: String,
        required: [true, 'Subject is required'],
        trim: true
    },
    description: {
        type: String,
        required: [true, 'Description is required'],
        trim: true
    },
    priority: {
        type: String,
        enum: ['low', 'medium', 'high', 'urgent'],
        default: 'medium'
    },
    status: {
        type: String,
        enum: ['open', 'in_progress', 'resolved', 'closed'],
        default: 'open'
    },
    category: {
        type: String,
        enum: ['technical', 'billing', 'feature_request', 'general'],
        default: 'technical'
    },
    responses: [{
        message: String,
        fromAdmin: Boolean,
        createdAt: {
            type: Date,
            default: Date.now
        }
    }],
    userPlan: {
        type: String,
        // Current plan ids, plus the retired ones so tickets created before the plan rename still load
        enum: [
            'free',
            'starter_monthly', 'starter_yearly',
            'pro_monthly', 'pro_yearly',
            'business_monthly', 'business_yearly',
            'admin',
            'monthly', 'halfYearly', 'yearly'
        ],
        default: 'free'
    }
}, {
    timestamps: true
});

// Add indexes for efficient queries
supportTicketSchema.index({ status: 1, priority: 1 });
supportTicketSchema.index({ userId: 1, status: 1 });
supportTicketSchema.index({ userPlan: 1, status: 1 });

const SupportTicket = mongoose.model('SupportTicket', supportTicketSchema);
export default SupportTicket;