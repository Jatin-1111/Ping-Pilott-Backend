// Run with: npm test
// E-mail verification and password-reset tokens are stored hashed, so reading the database does not give a working link.
// Links sent before the change (plain UUIDs in the database) keep working until they expire.

import test from 'node:test';
import assert from 'node:assert/strict';
import { hashToken, newEmailToken, tokenMatches } from '../utils/tokenHash.js';

test('a new token is long, URL-safe and different every time', () => {
    const a = newEmailToken();
    const b = newEmailToken();
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, b);
});

test('the stored value is a hash, not the token', () => {
    const token = newEmailToken();
    const stored = hashToken(token);
    assert.match(stored, /^[0-9a-f]{64}$/);
    assert.notEqual(stored, token);
});

test('the right token matches its stored hash, a wrong one does not', () => {
    const token = newEmailToken();
    const stored = hashToken(token);
    assert.equal(tokenMatches(stored, token), true);
    assert.equal(tokenMatches(stored, newEmailToken()), false);
    assert.equal(tokenMatches(stored, token + 'x'), false);
});

test('a leaked hash cannot be presented as the token', () => {
    const stored = hashToken(newEmailToken());
    assert.equal(tokenMatches(stored, stored), false);
});

test('a link sent before hashing (plain UUID in the database) still works', () => {
    const legacy = '3f2b8c1e-9d4a-4f6b-8a1c-2e7d5b9a0c44';
    assert.equal(tokenMatches(legacy, legacy), true);
    assert.equal(tokenMatches(legacy, '3f2b8c1e-9d4a-4f6b-8a1c-2e7d5b9a0c45'), false);
});

test('missing or empty values never match', () => {
    const stored = hashToken('abc');
    assert.equal(tokenMatches(undefined, 'abc'), false);
    assert.equal(tokenMatches(stored, undefined), false);
    assert.equal(tokenMatches('', ''), false);
    assert.equal(tokenMatches(stored, ''), false);
    assert.equal(tokenMatches(stored, ['abc']), false); // an array from ?token=a&token=b
    assert.equal(tokenMatches(stored, { $ne: 'x' }), false);
});
