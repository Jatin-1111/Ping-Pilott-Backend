// Email verification is off unless REQUIRE_EMAIL_VERIFICATION=true.
// With it off, new accounts are verified on creation and no verification email is sent, so sign-up works
// even where the server cannot send mail. Turn it on once mail delivery works.
export const requireEmailVerification = () => process.env.REQUIRE_EMAIL_VERIFICATION === 'true';
