// Run with: npm test
// A Slack, Discord or Telegram address in the webhook field gets that app's own message. Formats follow each service's
// documentation (Slack: {text}; Discord: {content} up to 2000 characters; Telegram: {chat_id, text} up to 4096).

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectChat, isChatWebhook, describeAlert, chatRequest, DISCORD_MAX, TELEGRAM_MAX } from '../utils/chatWebhook.js';
import { checkPlanLimits } from '../services/planLimits.js';
import { planFeatures } from '../utils/planFeatures.js';

// Built from parts: a whole Slack webhook address in a file is what GitHub's secret scanning blocks a push for, even a made-up one
const SLACK = ['https://hooks.slack.com/services', 'T00000000', 'B00000000', 'x'.repeat(24)].join('/');
const DISCORD = 'https://discord.com/api/webhooks/123456789012345678/abc_DEF-123.xyz';
const TELEGRAM = 'https://api.telegram.org/bot123456:ABC-def_GHI/sendMessage?chat_id=-1001234567890';

const server = { name: 'Shop', url: 'https://shop.example' };
const down = { error: 'HTTP 502: Bad Gateway', failureKind: 'http', statusCode: 502, responseTime: null };

// ---- detection ----

test('the three chat addresses are recognised, with where to send and (for Telegram) the chat', () => {
    assert.deepEqual(detectChat(SLACK), { kind: 'slack', url: SLACK });
    assert.deepEqual(detectChat(DISCORD), { kind: 'discord', url: DISCORD });
    assert.deepEqual(detectChat(TELEGRAM), {
        kind: 'telegram',
        url: 'https://api.telegram.org/bot123456:ABC-def_GHI/sendMessage',
        chatId: '-1001234567890'
    });
});

test('other Discord hosts and a versioned path work, and a query string or trailing slash is dropped', () => {
    assert.equal(detectChat('https://discordapp.com/api/webhooks/1/abc').kind, 'discord');
    assert.equal(detectChat('https://ptb.discord.com/api/v10/webhooks/1/abc/').kind, 'discord');
    assert.equal(detectChat('https://discord.com/api/webhooks/1/abc?wait=true').url, 'https://discord.com/api/webhooks/1/abc');
    assert.equal(detectChat('https://hooks.slack-gov.com/services/T1/B1/x').kind, 'slack');
});

test('Telegram needs a chat id (number or @channel), and passes a topic through', () => {
    assert.equal(detectChat('https://api.telegram.org/bot1:x/sendMessage'), null, 'no chat id');
    assert.equal(detectChat('https://api.telegram.org/bot1:x/sendMessage?chat_id=abc def'), null);
    assert.equal(detectChat('https://api.telegram.org/bot1:x/sendMessage?chat_id=@mychannel').chatId, '@mychannel');
    assert.equal(detectChat('https://api.telegram.org/bot1:x/sendMessage?chat_id=5&message_thread_id=77').threadId, 77);
    assert.equal(detectChat('https://api.telegram.org/bot1:x/getMe?chat_id=5'), null, 'only sendMessage');
});

test('anything else is an ordinary webhook, including look-alikes and other formats', () => {
    for (const url of [
        'https://example.com/hook',
        'http://hooks.slack.com/services/T/B/x',
        'https://hooks.slack.com.evil.example/services/T/B/x',
        'https://evil.example/hooks.slack.com/services/T/B/x',
        'https://hooks.slack.com/services/T/B',
        'https://discord.com/api/webhooks/1/abc/slack',
        'https://discord.com/channels/1/2',
        'https://user:pass@hooks.slack.com/services/T/B/x',
        'not a url',
        '',
        undefined
    ]) {
        assert.equal(detectChat(url), null, String(url));
        assert.equal(isChatWebhook(url), false);
    }
});

// ---- the messages ----

test('a down alert leads with the diagnosis, then the raw error, then the address', () => {
    const { title, lines } = describeAlert('server_down', server, down);
    assert.match(title, /Shop is DOWN/);
    assert.match(lines[0], /app behind it is not answering/);
    assert.match(lines[1], /^Likely cause: /);
    assert.match(lines[2], /^Try first: /);
    assert.equal(lines[3], 'Error: HTTP 502: Bad Gateway');
    assert.equal(lines[lines.length - 1], 'https://shop.example');
});

test('a down alert with nothing to explain is just the error', () => {
    const { lines } = describeAlert('server_down', server, { error: 'Something odd' });
    assert.deepEqual(lines, ['Error: Something odd', 'https://shop.example']);
});

test('recovery, slow and certificate alerts each say their own thing', () => {
    assert.deepEqual(describeAlert('server_recovery', server, { responseTime: 212.4 }).lines, ['Responding in 212 ms.', 'https://shop.example']);
    assert.match(describeAlert('server_recovery', server, {}).title, /back UP/);

    const slow = describeAlert('slow_response', server, {
        error: 'Slow response: 2310ms exceeds threshold of 1000ms', responseTime: 2310, timings: { dns: 5, connect: 5, tls: 20, ttfb: 2200, redirects: 0 }
    });
    assert.match(slow.title, /responding slowly/);
    assert.match(slow.lines.join('\n'), /Most of the time was spent on/);

    const cert = describeAlert('cert_expiring', server, { cert: { expiresAt: '2026-11-10T00:00:00.000Z', daysLeft: 16, level: 14 } });
    assert.match(cert.title, /expires in 16 days/);
    assert.ok(cert.lines.includes('Expires: 2026-11-10'));
    assert.match(describeAlert('cert_expiring', server, { cert: { expiresAt: '2026-11-10T00:00:00.000Z', daysLeft: 1, level: 1 } }).title, /1 day$/);
    assert.match(describeAlert('cert_expiring', server, {}).title, /about to expire/);
});

// ---- the requests ----

test('Slack gets {text} with bold title, and markup characters in the error are escaped', () => {
    const req = chatRequest('server_down', server, { ...down, error: 'HTTP 500: <!channel> & <https://evil.example|click>' }, SLACK);
    assert.equal(req.url, SLACK);
    assert.deepEqual(Object.keys(req.body), ['text']);
    assert.match(req.body.text, /^\*\u{1F534} Shop is DOWN\*/u);
    assert.ok(!req.body.text.includes('<!channel>'));
    assert.ok(req.body.text.includes('&lt;!channel&gt; &amp; &lt;https://evil.example|click&gt;'));
});

test('Discord gets {content} that pings nobody and fits 2000 characters', () => {
    const req = chatRequest('server_down', server, { ...down, error: `HTTP 500: @everyone ${'x'.repeat(5000)}` }, DISCORD);
    assert.equal(req.url, DISCORD);
    assert.deepEqual(req.body.allowed_mentions, { parse: [] });
    assert.ok(req.body.content.startsWith('**\u{1F534} Shop is DOWN**'));
    assert.equal(req.body.content.length, DISCORD_MAX);
    assert.ok(req.body.content.endsWith('…'));
});

test('Telegram gets chat_id and plain text, no preview, no markup mode, and fits 4096 characters', () => {
    const req = chatRequest('server_down', server, { ...down, error: `HTTP 500: ${'y'.repeat(9000)}` }, `${TELEGRAM}&message_thread_id=9`);
    assert.equal(req.url, 'https://api.telegram.org/bot123456:ABC-def_GHI/sendMessage');
    assert.equal(req.body.chat_id, '-1001234567890');
    assert.equal(req.body.message_thread_id, 9);
    assert.deepEqual(req.body.link_preview_options, { is_disabled: true });
    assert.equal('parse_mode' in req.body, false);
    assert.equal(req.body.text.length, TELEGRAM_MAX);
});

test('an ordinary webhook gets no chat request, so it is sent as JSON as before', () => {
    assert.equal(chatRequest('server_down', server, down, 'https://example.com/hook'), null);
});

test('a short message is not cut', () => {
    const req = chatRequest('server_recovery', server, { responseTime: 120 }, DISCORD);
    assert.ok(!req.body.content.endsWith('…'));
    assert.ok(req.body.content.length < 200);
});

// ---- plans ----

test('chat addresses are free on every plan; any other webhook needs a paid plan', () => {
    const user = (plan) => ({ role: 'user', subscription: { plan, features: planFeatures(plan) } });
    for (const url of [SLACK, DISCORD, TELEGRAM]) {
        assert.equal(checkPlanLimits(user('free'), { alerts: { webhookUrl: url } }), null, url);
    }
    assert.match(checkPlanLimits(user('free'), { alerts: { webhookUrl: 'https://example.com/hook' } }), /free on every plan.*paid plan/);
    assert.equal(checkPlanLimits(user('starter_monthly'), { alerts: { webhookUrl: 'https://example.com/hook' } }), null);
});
