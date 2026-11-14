// Email verification is off unless REQUIRE_EMAIL_VERIFICATION=true.
// With it off, new accounts are verified on creation and no verification email is sent, so sign-up works
// even where the server cannot send mail. Turn it on once mail delivery works.
export const requireEmailVerification = () => process.env.REQUIRE_EMAIL_VERIFICATION === 'true';

/**
 * What to say at start-up when verification is off in production, or null. With it off anyone can register with an address they
 * do not own, which is also how third parties end up as alert contacts. It stays off by default because turning it on needs
 * working mail delivery (a failed verification mail locks the new account out until "resend"), so this is a notice, not a change.
 */
export function emailVerificationNotice(env = process.env) {
    if (env.NODE_ENV !== 'production' || env.REQUIRE_EMAIL_VERIFICATION === 'true') return null;
    return 'Email verification is OFF (REQUIRE_EMAIL_VERIFICATION is not "true"): new accounts are marked verified without proving they own their address. Turn it on once mail delivery is reliable.';
}
