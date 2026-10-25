// Run with: npm test
// The token a host agent signs in with: made once, only its hash kept, and compared without giving anything away.

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateToken, parseToken, bearerToken, secretMatches, hashSecret } from '../utils/agentToken.js';

test('a token has an id to find the server with and a secret that proves it, and only the hash is kept', () => {
    const { token, tokenId, tokenHash } = generateToken();
    assert.match(token, /^ppa_[0-9a-f]{24}_[A-Za-z0-9_-]{43}$/);
    assert.equal(tokenId.length, 24);
    assert.match(tokenHash, /^[0-9a-f]{64}$/);
    assert.ok(!token.includes(tokenHash), 'the hash is not in the token');
    assert.ok(!tokenHash.includes(parseToken(token).secret), 'the secret is not in the hash');
});

test('two tokens are never the same', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken().token));
    assert.equal(tokens.size, 200);
});

test('a token is read back into its id and secret, and anything else is nothing', () => {
    const { token, tokenId } = generateToken();
    const parsed = parseToken(token);
    assert.equal(parsed.tokenId, tokenId);
    assert.equal(hashSecret(parsed.secret), generateTokenHashOf(token));

    const bad = [
        undefined, null, '', 'ppa_', 'ppa_abc_def', 5, {}, [],
        `${token}x`, ` ${token}`, token.replace('ppa_', 'ppb_'), token.toUpperCase(),
        `ppa_${'0'.repeat(23)}_${'a'.repeat(43)}`, `ppa_${'g'.repeat(24)}_${'a'.repeat(43)}`,
        `${token}\n`, `${token}; DROP`, `${token} ${token}`
    ];
    for (const value of bad) assert.equal(parseToken(value), null, String(value));
});

function generateTokenHashOf(token) {
    return hashSecret(parseToken(token).secret);
}

test('the header must be exactly "Bearer <token>"', () => {
    assert.equal(bearerToken('Bearer abc'), 'abc');
    assert.equal(bearerToken('bearer abc'), 'abc');
    assert.equal(bearerToken('  Bearer   abc  '), 'abc');
    for (const nothing of [undefined, null, '', 'Bearer', 'Bearer ', 'Basic abc', 'abc', 'Bearer a b', 5]) assert.equal(bearerToken(nothing), null, String(nothing));
});

test('the right secret matches its hash, a wrong one and a missing hash do not', () => {
    const { token, tokenHash } = generateToken();
    const { secret } = parseToken(token);
    assert.equal(secretMatches(secret, tokenHash), true);
    assert.equal(secretMatches(`${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`, tokenHash), false);
    assert.equal(secretMatches('', tokenHash), false);
    for (const missing of [undefined, null, '', 'short', 'z'.repeat(64), 5]) assert.equal(secretMatches(secret, missing), false, String(missing));
});

test('a token made before is no use after a new one replaces its hash', () => {
    const old = generateToken();
    const replacement = generateToken();
    assert.equal(secretMatches(parseToken(old.token).secret, replacement.tokenHash), false);
    assert.equal(secretMatches(parseToken(replacement.token).secret, replacement.tokenHash), true);
});
