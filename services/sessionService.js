// services/sessionService.js - sign-in sessions the server can end
//
// Before: access and refresh tokens were stateless. Using a refresh token returned a new one and left the old one valid, there
// was no logout, and a copied refresh token kept working for its whole 7 days (and could be renewed for ever).
//
// Now:
//  - every refresh token has a record (models/RefreshToken.js) and is accepted ONCE; using it issues the next token in the
//    same family;
//  - a token shown again after a short leeway (a retry whose answer was lost is fine) is a copy: the whole family is revoked;
//  - logout revokes the family, logout-everywhere also raises the user's tokenVersion, which every access token carries
//    (`tv`) and every request checks, so all access tokens of that user stop working at once;
//  - tokens issued before this change have no jti: each is accepted once and replaced by a tracked one, so nobody is signed out.

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

export class SessionError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'SessionError';
        this.code = code;
    }
}

const defaultSecrets = () => ({ access: process.env.JWT_SECRET, refresh: process.env.JWT_REFRESH_SECRET });

/**
 * @param {Object} deps  all replaceable in tests
 * @param {Object} deps.RefreshToken  the model (create, findOneAndUpdate, findById, updateMany)
 */
export function createSessionService({
    RefreshToken,
    now = Date.now,
    randomId = () => crypto.randomUUID(),
    secrets = defaultSecrets,
    // Short, because a single device logging out cannot recall its access token: 1 hour by default (it used to be 1 day).
    // Clients renew it with the refresh token.
    accessTtl = () => process.env.JWT_EXPIRES_IN || '1h',
    refreshTtl = () => process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    // A refresh whose answer never arrived is retried with the same token: allow that within this window
    leewayMs = () => parseInt(process.env.REFRESH_REUSE_LEEWAY_MS, 10) || 10000
}) {
    /** A new access + refresh token pair for `user`. `family` continues a sign-in; leave it out for a new one. */
    async function issue(user, family = randomId()) {
        const id = String(user._id ?? user.id);
        const tv = user.tokenVersion || 0;
        const jti = randomId();
        const { access, refresh } = secrets();

        const token = jwt.sign({ id, tv }, access, { expiresIn: accessTtl() });
        const refreshToken = jwt.sign({ id, tv, jti, fam: family }, refresh, { expiresIn: refreshTtl() });

        const { exp } = jwt.decode(refreshToken);
        await RefreshToken.create({ _id: jti, userId: id, family, expiresAt: new Date(exp * 1000) });
        return { token, refreshToken };
    }

    /** The claims of a refresh token, or throws when the signature is wrong or it has expired */
    function verifyRefresh(refreshToken) {
        try {
            return jwt.verify(refreshToken, secrets().refresh);
        } catch (error) {
            throw new SessionError('INVALID', 'Invalid or expired refresh token');
        }
    }

    async function revokeFamily(family) {
        await RefreshToken.updateMany({ family, revokedAt: null }, { $set: { revokedAt: new Date(now()) } });
    }

    /** End every session of a user (their refresh tokens; the caller raises tokenVersion for the access tokens) */
    async function revokeUser(userId) {
        await RefreshToken.updateMany({ userId: String(userId), revokedAt: null }, { $set: { revokedAt: new Date(now()) } });
    }

    /**
     * Spend a refresh token. Returns the family the next token belongs to, or throws SessionError.
     * @param {Object} decoded  the claims from verifyRefresh
     */
    async function consume(decoded) {
        // issued before sessions were tracked: accept this once and start a family for it
        if (!decoded.jti) return { family: randomId(), legacy: true };

        const spent = await RefreshToken.findOneAndUpdate(
            { _id: decoded.jti, usedAt: null, revokedAt: null },
            { $set: { usedAt: new Date(now()) } }
        );
        if (spent) return { family: spent.family };

        const record = await RefreshToken.findById(decoded.jti).lean();
        if (!record) throw new SessionError('UNKNOWN', 'Invalid refresh token');
        if (record.revokedAt) throw new SessionError('REVOKED', 'Invalid refresh token');

        // used before: a retry just after the first use is allowed; later it can only be a copy, so end the whole sign-in
        if (now() - new Date(record.usedAt).getTime() <= leewayMs()) return { family: record.family, replay: true };
        await revokeFamily(record.family);
        throw new SessionError('REUSED', 'Invalid refresh token');
    }

    /** Logout: end the sign-in this refresh token belongs to. Never throws for a token that is already dead. */
    async function logout(refreshToken) {
        let decoded;
        try {
            decoded = jwt.verify(refreshToken, secrets().refresh, { ignoreExpiration: true });
        } catch {
            return false;
        }
        if (!decoded.fam) return false;
        await revokeFamily(decoded.fam);
        return true;
    }

    return { issue, verifyRefresh, consume, revokeFamily, revokeUser, logout };
}

export default { createSessionService, SessionError };
