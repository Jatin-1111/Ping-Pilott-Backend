// utils/chatWebhook.js - alerts to Slack, Discord and Telegram, from the same address field as a webhook
//
// A user pastes the address their chat app gave them. If it is one of these three it gets that app's own message format
// (each wants a different body, which a plain JSON webhook cannot satisfy). Anything else is an ordinary webhook.
//
//   Slack     POST {"text": ...} to https://hooks.slack.com/services/T../B../token  (docs.slack.dev, incoming webhooks)
//   Discord   POST {"content": ...} to https://discord.com/api/webhooks/{id}/{token}   content is at most 2000 characters;
//             204 on success (docs.discord.com, Execute Webhook)
//   Telegram  POST {"chat_id", "text"} to https://api.telegram.org/bot<token>/sendMessage   text is 1 to 4096 characters
//             (core.telegram.org/bots/api#sendmessage). The chat id rides in the address as ?chat_id=
//
// The text of an alert contains things a monitored site controls (the error it answered with), so it is made harmless
// for each app: Slack's markup characters are escaped, Discord is told to ping nobody, Telegram gets plain text.
//
// Pure functions (no network), so every format can be tested on its own. The web app has a small copy of detectChat
// (lib/chatWebhook.js there) for the hint under the field: keep the two in step.

import { describeDominantPhase } from './timings.js';
import { describeFlap } from './flapDamping.js';
import { cleanCert } from './certExpiry.js';
import { diagnose } from './diagnosis.js';

const SLACK_HOSTS = new Set(['hooks.slack.com', 'hooks.slack-gov.com']);
const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);
const DISCORD_PATH = /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9._-]+\/?$/;
const TELEGRAM_PATH = /^\/bot[^/]+\/sendMessage\/?$/i;

export const DISCORD_MAX = 2000;
export const TELEGRAM_MAX = 4096;

export const CHAT_LABELS = { slack: 'Slack', discord: 'Discord', telegram: 'Telegram' };

/**
 * @param {string} rawUrl  what the user typed into the webhook field
 * @returns {{ kind: 'slack'|'discord'|'telegram', url: string, chatId?: string, threadId?: number }|null}
 *   `url` is where to POST. null for anything that is not one of the three (a Discord address ending /slack or /github
 *   speaks another app's format, so it is left to the ordinary webhook).
 */
export function detectChat(rawUrl) {
    let parsed;
    try {
        parsed = new URL(String(rawUrl || '').trim());
    } catch {
        return null;
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    const host = parsed.hostname.toLowerCase();

    if (SLACK_HOSTS.has(host) && /^\/services\/[^/]+\/[^/]+\/[^/]+\/?$/.test(parsed.pathname)) {
        return { kind: 'slack', url: `${parsed.origin}${parsed.pathname}` };
    }

    if (DISCORD_HOSTS.has(host) && DISCORD_PATH.test(parsed.pathname)) {
        return { kind: 'discord', url: `${parsed.origin}${parsed.pathname}` };
    }

    if (host === 'api.telegram.org' && TELEGRAM_PATH.test(parsed.pathname)) {
        const chatId = (parsed.searchParams.get('chat_id') || '').trim();
        if (!/^(-?\d+|@[A-Za-z0-9_]{5,})$/.test(chatId)) return null;
        const thread = parseInt(parsed.searchParams.get('message_thread_id') || '', 10);
        return {
            kind: 'telegram',
            url: `${parsed.origin}${parsed.pathname}`,
            chatId,
            ...(Number.isInteger(thread) && thread > 0 ? { threadId: thread } : {})
        };
    }

    return null;
}

export const isChatWebhook = (rawUrl) => detectChat(rawUrl) !== null;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The alert as a title and some plain lines, before it is dressed for an app.
 * @param {string} alertType  'server_down' | 'server_recovery' | 'slow_response' | 'cert_expiring' | anything else
 * @param {Object} server     { name, url }
 * @param {Object} payload    what the webhook carries: error, failureKind, statusCode, responseTime, timings, flap, cert
 * @returns {{ title: string, lines: string[] }}
 */
export function describeAlert(alertType, server, payload = {}) {
    const name = server.name || 'A server';
    const lines = [];
    const flap = describeFlap(payload.flap);
    let title;

    if (alertType === 'server_down') {
        title = `\u{1F534} ${name} is DOWN`;
        const diagnosis = diagnose({ kind: payload.failureKind, statusCode: payload.statusCode, error: payload.error });
        if (diagnosis) {
            lines.push(diagnosis.title, `Likely cause: ${diagnosis.cause}`, `Try first: ${diagnosis.action}`);
        }
        if (payload.error) lines.push(`Error: ${payload.error}`);
    } else if (alertType === 'server_recovery') {
        title = `✅ ${name} is back UP`;
        if (Number(payload.responseTime) > 0) lines.push(`Responding in ${Math.round(Number(payload.responseTime))} ms.`);
    } else if (alertType === 'slow_response') {
        title = `\u{1F40C} ${name} is responding slowly`;
        if (payload.error) lines.push(String(payload.error));
        const where = describeDominantPhase(payload.timings, payload.responseTime);
        if (where) lines.push(where);
    } else if (alertType === 'cert_expiring') {
        const cert = cleanCert(payload.cert);
        title = cert
            ? `\u{1F512} The security certificate for ${name} expires in ${plural(cert.daysLeft, 'day')}`
            : `\u{1F512} The security certificate for ${name} is about to expire`;
        if (cert) lines.push(`Expires: ${cert.expiresAt.slice(0, 10)}`);
        lines.push('Renew it before then, or visitors will see a security warning.');
    } else {
        title = `${name}: status update`;
    }

    if (flap) lines.push(flap);
    if (server.url) lines.push(server.url);
    return { title, lines };
}

const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

// Slack reads &, < and > as markup (links, @channel, @here), so they are written out
const slackEscape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * @returns {{ url: string, body: Object }|null}  the request to send, or null when `webhookUrl` is not a chat address
 */
export function chatRequest(alertType, server, payload, webhookUrl) {
    const chat = detectChat(webhookUrl);
    if (!chat) return null;
    const { title, lines } = describeAlert(alertType, server, payload);

    if (chat.kind === 'slack') {
        return { url: chat.url, body: { text: [`*${slackEscape(title)}*`, ...lines.map(slackEscape)].join('\n') } };
    }

    if (chat.kind === 'discord') {
        return {
            url: chat.url,
            body: {
                content: clip([`**${title}**`, ...lines].join('\n'), DISCORD_MAX),
                // a site's error text must not be able to ping @everyone
                allowed_mentions: { parse: [] }
            }
        };
    }

    return {
        url: chat.url,
        body: {
            chat_id: chat.chatId,
            ...(chat.threadId ? { message_thread_id: chat.threadId } : {}),
            text: clip([title, ...lines].join('\n'), TELEGRAM_MAX),
            link_preview_options: { is_disabled: true }
        }
    };
}

export default { detectChat, isChatWebhook, describeAlert, chatRequest, CHAT_LABELS, DISCORD_MAX, TELEGRAM_MAX };
