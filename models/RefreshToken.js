// models/RefreshToken.js - one record per refresh token that was issued (see services/sessionService.js)
//
// The token itself is a signed JWT carrying `jti` (this record's _id) and `fam` (the sign-in it belongs to). Keeping a
// record is what makes a session something the server can end: a refresh token is accepted once, the next one replaces it,
// and a token that is shown a second time means it was copied, so the whole family is revoked.

import mongoose from 'mongoose';

const refreshTokenSchema = new mongoose.Schema({
    _id: { type: String, required: true }, // the token's jti
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    family: { type: String, required: true, index: true }, // all the tokens that came from one sign-in
    usedAt: { type: Date, default: null }, // set when it was exchanged for the next one
    revokedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true }
}, { versionKey: false });

// Tidy-up only: an expired token is refused by its signature anyway. Kept a day past expiry.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);
export default RefreshToken;
