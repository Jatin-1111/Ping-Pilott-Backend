// models/Lock.js - short-lived locks, one document per lock name (see utils/userLock.js)
//
// The document _id is the lock name, so MongoDB's unique _id is what makes taking a lock atomic. `expiresAt` decides
// whether a held lock is still valid (a crashed holder cannot block anyone for more than its ttl); the TTL index only
// tidies old documents up and is not needed for correctness.

import mongoose from 'mongoose';

const lockSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    owner: { type: String, required: true },
    expiresAt: { type: Date, required: true }
}, { versionKey: false });

lockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 });

const Lock = mongoose.model('Lock', lockSchema);
export default Lock;
