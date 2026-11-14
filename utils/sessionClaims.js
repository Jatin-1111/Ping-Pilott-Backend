// utils/sessionClaims.js - is this token's session still alive? One rule for REST (middleware/auth.js), the refresh
// endpoint and the socket handshake. They used to differ: the socket accepted tokens that REST refused after a password change.

/**
 * @param {Object} user     the user as stored (tokenVersion and passwordChangedAt may be missing on older accounts)
 * @param {Object} decoded  the verified token claims (iat, tv)
 * @returns {{ code: string, message: string } | null}  why the session ended, or null when it is fine
 */
export function checkSessionClaims(user, decoded) {
    // "Sign out everywhere" raises the user's tokenVersion; tokens carry the version they were issued under
    if ((decoded.tv ?? 0) !== (user.tokenVersion ?? 0)) {
        return { code: 'session_ended', message: 'Your session has ended. Please sign in again.' };
    }

    // A password change or reset signs out every session that existed before it
    if (user.passwordChangedAt && decoded.iat < Math.floor(new Date(user.passwordChangedAt).getTime() / 1000)) {
        return { code: 'password_changed', message: 'Your password was changed. Please sign in again.' };
    }

    return null;
}

export default { checkSessionClaims };
