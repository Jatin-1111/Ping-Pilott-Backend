// models/StatusPage.js - a public page showing how some of a user's monitors are doing
//
// The page is read by strangers with no sign-in (GET /api/public/status/:slug), so what it can show is fixed in
// utils/statusPage.js: a display name, current state, daily uptime and incident times for the monitors listed here.
// Never an address, an error message or anything else about the server.

import mongoose from 'mongoose';

const componentSchema = new mongoose.Schema({
    serverId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    // What visitors see instead of the server's name, e.g. "Website" or "Checkout API". Empty means the server's name.
    label: {
        type: String,
        trim: true,
        maxlength: 60,
        default: ''
    }
}, { _id: false });

const statusPageSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    // The address: /status/<slug>. Lowercase letters, numbers and hyphens (utils/statusPage.js)
    slug: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    title: {
        type: String,
        required: true,
        trim: true,
        maxlength: 80
    },
    description: {
        type: String,
        trim: true,
        maxlength: 300,
        default: ''
    },
    // In the order they are shown
    servers: {
        type: [componentSchema],
        default: []
    },
    // A page nobody can see until the owner turns this on
    published: {
        type: Boolean,
        default: false
    },
    // Search engines may list it. Off by default.
    indexable: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

const StatusPage = mongoose.model('StatusPage', statusPageSchema);
export default StatusPage;
