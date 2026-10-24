// Run with: npm test
// Regression for F8: a "database" monitor accepted postgres://app:secret@db.example.com:5432/prod. The address was
// stored as typed and copied into every alert email (up to 5 recipients), the in-app feed and webhook payloads, and a
// webhook address (a secret for Slack, Discord and Teams) was written to the log in full.

import test from 'node:test';
import assert from 'node:assert/strict';
import { containsCredentials, maskCredentials } from '../utils/address.js';
import { createServerSchema, updateServerSchema, formatZodIssues } from '../utils/validations.js';
import { sendAlertChannels, webhookLabel } from '../services/alertService.js';

test('addresses with a username or password are recognised', () => {
    for (const address of [
        'postgres://app:secret@db.example.com:5432/prod',
        'mysql://root:pw@10.0.0.5',
        'https://user:pass@example.com/health',
        'http://token@example.com',
        'app:secret@db.example.com:5432',
        'user@host.example.com:22',
        'redis://:onlypassword@cache.example.com:6379',
        'postgres://app:p@ss@db.example.com',
    ]) {
        assert.equal(containsCredentials(address), true, address);
    }
});

test('ordinary addresses, including ones with an @ later on, are fine', () => {
    for (const address of [
        'example.com',
        'https://example.com/path',
        'http://example.com:8080/health',
        'https://example.com/@team',
        'https://example.com/login?email=a@b.com',
        'example.com?mail=a@b.com',
        'db.example.com:5432',
        'postgres://db.example.com:5432/prod',
        'redis://cache.example.com',
        '[2001:db8::1]:443',
    ]) {
        assert.equal(containsCredentials(address), false, address);
    }
});

test('masking replaces the credentials and leaves the rest', () => {
    assert.equal(maskCredentials('postgres://app:secret@db.example.com:5432/prod'), 'postgres://***@db.example.com:5432/prod');
    assert.equal(maskCredentials('postgres://app:p@ss@db.example.com'), 'postgres://***@db.example.com');
    assert.equal(maskCredentials('app:secret@db.example.com:5432'), '***@db.example.com:5432');
    assert.equal(maskCredentials('https://example.com/@team'), 'https://example.com/@team');
    assert.equal(maskCredentials('example.com'), 'example.com');
    assert.equal(maskCredentials(undefined), undefined);
});

test('creating a server with credentials in the address is rejected, with a message that says what to do', () => {
    const result = createServerSchema.safeParse({ name: 'Prod DB', type: 'database', url: 'postgres://app:secret@db.example.com:5432/prod' });
    assert.equal(result.success, false);
    const issues = formatZodIssues(result.error);
    assert.equal(issues[0].field, 'url');
    assert.match(issues[0].message, /Remove the username and password/);
    assert.doesNotMatch(JSON.stringify(issues), /secret/, 'the error does not echo the password back');
});

test('updating the address to one with credentials is rejected too, and updates without an address are untouched', () => {
    assert.equal(updateServerSchema.safeParse({ url: 'https://u:p@example.com' }).success, false);
    assert.equal(updateServerSchema.safeParse({ name: 'Renamed' }).success, true);
});

test('normal addresses are still accepted', () => {
    assert.equal(createServerSchema.safeParse({ name: 'Shop', url: 'https://example.com' }).success, true);
    assert.equal(createServerSchema.safeParse({ name: 'DB', type: 'database', url: 'postgres://db.example.com:5432' }).success, true);
});

test('alerts carry the masked address, so a password saved before this check never reaches contacts or webhooks', async () => {
    let emailed;
    let posted;
    await sendAlertChannels(
        { name: 'Prod DB', url: 'postgres://app:secret@db.example.com:5432/prod', status: 'up', contactEmails: ['a@example.com'], monitoring: { alerts: { webhookUrl: 'https://hooks.example.com/x' } } },
        'server_down',
        { status: 'down', error: 'Connection refused' },
        {},
        { sendEmail: async (server) => { emailed = server.url; }, sendWebhook: async (server) => { posted = server.url; } }
    );
    assert.equal(emailed, 'postgres://***@db.example.com:5432/prod');
    assert.equal(posted, 'postgres://***@db.example.com:5432/prod');
});

test('a webhook is named by its host in the log, never by the address with its secret', () => {
    const label = webhookLabel('https://hooks.slack.com/services/T000/B000/SECRETTOKEN');
    assert.equal(label, 'hooks.slack.com');
    assert.doesNotMatch(label, /SECRETTOKEN|services/);
    assert.equal(webhookLabel(''), 'the configured webhook');
});
