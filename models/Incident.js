// models/Incident.js - one row per outage: opened when a server goes down, closed when it stops being down
//
// Written by services/incidentService.js from the one place a check result is applied (checkRecorder).
// Reading this is cheap; rebuilding outages from the per-check history on every page load is not.

import mongoose from 'mongoose';

const incidentSchema = new mongoose.Schema({
    serverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Server',
        required: true
    },
    // The owner of the server, copied here so a user's incidents are one indexed query
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    startedAt: {
        type: Date,
        required: true
    },
    // null while the server is still down
    endedAt: {
        type: Date,
        default: null
    },
    // The first error the failing checks reported
    error: {
        type: String,
        default: null
    },
    // and its kind (utils/failures.js), so incidents can be told apart without reading the text
    failureKind: {
        type: String,
        default: null
    },
    // What the first failing check found, for the incident page: the step it stopped in (utils/failurePhase.js), the HTTP
    // status, the steps that finished (utils/timings.js) and what the server said (utils/evidence.js). The evidence is
    // removed after the check retention period (tasks/dataRetention.js); the rest stays as long as the incident.
    failedPhase: {
        type: String,
        default: null
    },
    statusCode: {
        type: Number,
        default: null
    },
    timings: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    // Not in the fields unless asked for (select('+evidence')): it is a plan feature (see Server.failureEvidence)
    evidence: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
        select: false
    },
    // true only while the incident is ongoing. A flag rather than "endedAt is null" because a unique partial
    // index can match on it, which guarantees a server never has two ongoing incidents.
    open: {
        type: Boolean,
        default: true
    }
});

// A user's list, newest first
incidentSchema.index({ userId: 1, startedAt: -1 });
// At most one ongoing incident per server, even if two checks race
incidentSchema.index({ serverId: 1 }, { unique: true, partialFilterExpression: { open: true } });
// Resolved incidents are kept for 90 days. Ongoing ones have no endedAt, so they never expire.
incidentSchema.index({ endedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const Incident = mongoose.model('Incident', incidentSchema);
export default Incident;
