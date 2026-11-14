// utils/passwordPolicy.js - what a new password has to be
//
// The only rule was "at least 6 characters", so `123456` and `password` were accepted, and bcrypt silently ignores everything past
// 72 bytes (a user who chose a long passphrase could sign in with any ending). The policy applies where a password is CHOSEN:
// sign-up, reset, change and creating an admin. Signing in is not checked, so existing accounts with shorter passwords still work.

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_BYTES = 72; // bcrypt's limit

// Passwords that are tried first by anyone guessing. Compared lower-case, and also after common look-alike characters are
// swapped and trailing digits and symbols are cut off ("P@ssw0rd2026!" is "password").
const COMMON = new Set([
    'password', 'password1', 'password12', 'password123', 'passw0rd', 'passw0rd1', 'p4ssw0rd', 'pass1234', 'passpass',
    '12345678', '123456789', '1234567890', '0123456789', '11111111', '22222222', '00000000', '87654321', '123123123', '12341234',
    '1q2w3e4r', '1q2w3e4r5t', '1qaz2wsx', '1qazxsw2', 'zaq12wsx', 'qazwsxedc', 'q1w2e3r4', 'q1w2e3r4t5',
    'qwertyui', 'qwerty12', 'qwerty123', 'qwertyuiop', 'qwertyuiop123', 'asdfghjk', 'asdfghjkl', 'asdf1234', 'zxcvbnm1', 'zxcvbnm123',
    'abcd1234', 'abc12345', 'abcdefgh', 'abcdefg1', 'aa123456', 'a1234567', 'a12345678', 'aaaaaaaa',
    'iloveyou', 'iloveyou1', 'iloveyou2', 'admin123', 'admin1234', 'administrator', 'welcome1', 'welcome123', 'letmein1', 'letmein123',
    'monkey123', 'dragon123', 'football', 'football1', 'baseball', 'baseball1', 'superman', 'sunshine', 'princess', 'trustno1',
    'master123', 'shadow123', 'michael1', 'jennifer', 'charlie1', 'changeme', 'changeme1', 'changeme123', 'default123', 'test1234',
    'testtest', 'test12345', 'login123', 'user1234', 'guest123', 'temp1234', 'secret123', 'p@ssw0rd', 'p@ssword', 'pa$$w0rd',
    'pingpilot', 'pingpilot1', 'pingpilot123', 'pingpilott', 'pingpilott1', 'pingpilott123', 'monitoring', 'monitor123', 'uptime123'
]);

// What those are made of, for the "trailing digits and symbols cut off" check
const COMMON_BASES = new Set([
    'password', 'passw0rd', 'passpass', 'qwerty', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'letmein', 'welcome', 'admin', 'administrator',
    'iloveyou', 'monkey', 'dragon', 'master', 'sunshine', 'princess', 'football', 'baseball', 'superman', 'shadow', 'michael',
    'trustno', 'changeme', 'default', 'secret', 'pingpilot', 'pingpilott', 'monitoring'
]);

const LOOK_ALIKES = { '@': 'a', '$': 's', '0': 'o', '3': 'e', '4': 'a', '5': 's' };
const unleet = (value) => value.replace(/[@$03-5]/g, (c) => LOOK_ALIKES[c]);

/**
 * Why this password cannot be chosen, or null when it can.
 * @param {unknown} password
 */
export function passwordProblem(password) {
    if (typeof password !== 'string') return 'Enter a password.';
    if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
        return `Use at most ${MAX_PASSWORD_BYTES} bytes (about ${MAX_PASSWORD_BYTES} characters): anything longer is cut off when it is stored.`;
    }

    const lower = password.toLowerCase();
    if (new Set(lower).size === 1) return 'That password is too simple. Choose something less guessable.';

    const base = unleet(lower.replace(/[\d\W_]+$/, ''));
    if (COMMON.has(lower) || COMMON.has(unleet(lower)) || COMMON_BASES.has(base)) {
        return 'That password is too common. Choose something less guessable.';
    }
    return null;
}

/** For express-validator: `body('password').custom(passwordRule)` */
export function passwordRule(value) {
    const problem = passwordProblem(value);
    if (problem) throw new Error(problem);
    return true;
}

export default { passwordProblem, passwordRule, MIN_PASSWORD_LENGTH, MAX_PASSWORD_BYTES };
