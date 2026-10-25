// Run with: npm test
// F14: small gaps in history and server edits. The rules live in utils/serverEdits.js so they can be tested without the
// database.

import test from 'node:test';
import assert from 'node:assert/strict';
import { clampLimit, normalizeUrl, addressChangeUpdates, nextCheckEstimate } from '../utils/serverEdits.js';

test('a negative or zero history limit no longer reaches Mongo as a negative $limit', () => {
    const options = { max: 1440, fallback: 300 };
    assert.equal(clampLimit('-5', options), 1);
    assert.equal(clampLimit('0', options), 1);
    assert.equal(clampLimit('50', options), 50);
    assert.equal(clampLimit('99999', options), 1440);
    assert.equal(clampLimit(undefined, options), 300);
    assert.equal(clampLimit('abc', options), 300);
});

test('the scheme and host are lower-cased, so Example.com and example.com are one server', () => {
    assert.equal(normalizeUrl('Example.COM'), 'example.com');
    assert.equal(normalizeUrl('HTTPS://Example.com/'), 'example.com');
    assert.equal(normalizeUrl('HTTP://Example.com:8080/Path'), 'http://example.com:8080/Path');
    assert.equal(normalizeUrl('postgres://DB.Example.com:5432/Prod'), 'postgres://db.example.com:5432/Prod');
    assert.equal(normalizeUrl('Example.com/CaseSensitive?Q=1'), 'example.com/CaseSensitive?Q=1');
});

test('normalizeUrl keeps its earlier rules: https dropped, trailing slash dropped, too short is null', () => {
    assert.equal(normalizeUrl('https://example.com'), 'example.com');
    assert.equal(normalizeUrl('http://example.com'), 'http://example.com');
    assert.equal(normalizeUrl('a'), null);
    assert.equal(normalizeUrl(''), null);
    assert.equal(normalizeUrl(undefined), null);
});

test('an address change resets the status, the response and the schedule slot', () => {
    assert.deepEqual(addressChangeUpdates(), { status: 'unknown', error: null, failureKind: null, responseTime: null, serverTime: null, slowAlerted: false, slowStreak: 0, fastStreak: 0, alertedStatus: null, statusChanges: [], flapHeldAt: null, certExpiresAt: null, certAlertedDays: null, nextCheckAt: null });
});

const NOW = new Date('2026-10-24T12:00:00Z');
const base = { uploadedPlan: 'pro_monthly', timezone: 'UTC', monitoring: { frequency: 5, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timeWindows: [{ start: '00:00', end: '23:59' }] } };

test('the estimate says when a server is due, or that it is due now, or that it was never checked', () => {
    assert.equal(nextCheckEstimate({ ...base, lastChecked: null }, NOW), 'Never checked');
    assert.equal(nextCheckEstimate({ ...base, lastChecked: new Date('2026-10-24T11:50:00Z') }, NOW), 'Due now');
    assert.equal(nextCheckEstimate({ ...base, lastChecked: new Date('2026-10-24T11:58:00Z') }, NOW), '2026-10-24T12:03:00.000Z');
});

test('a server on an ended free trial says so instead of "Due now" for ever', () => {
    const server = { ...base, uploadedPlan: 'free', lastChecked: new Date('2026-10-20T00:00:00Z'), monitoring: { ...base.monitoring, trialEndsAt: new Date('2026-10-22T00:00:00Z') } };
    assert.equal(nextCheckEstimate(server, NOW), 'Paused: trial ended');
    assert.equal(nextCheckEstimate({ ...server, uploadedRole: 'admin' }, NOW), 'Due now');
});

test('a server outside its check days or hours says so', () => {
    const closed = { ...base, lastChecked: new Date('2026-10-20T00:00:00Z'), monitoring: { ...base.monitoring, timeWindows: [{ start: '01:00', end: '02:00' }] } };
    assert.equal(nextCheckEstimate(closed, NOW), 'Outside check hours');
});
