import logger from '../utils/logger.js';
import { sendAlertEmail } from './emailService.js';
import ServerCheck from '../models/ServerCheck.js';
import axios from 'axios';
import http from 'http';
import https from 'https';
import { safeLookup, assertPublicHost, blockPrivateRedirect, hostFromTarget } from '../utils/ssrfGuard.js';
import { maskCredentials } from '../utils/address.js';
import { localParts, timeInWindow, timezoneOf } from '../utils/schedule.js';
import { cleanTimings } from '../utils/timings.js';
import { cleanFlap } from '../utils/flapDamping.js';
import { cleanCert } from '../utils/certExpiry.js';
import { diagnose } from '../utils/diagnosis.js';

// Webhooks go to addresses users typed in, so they get the same private-network protection as checks,
// and redirects are not followed.
const webhookClient = axios.create({
    timeout: 5000,
    maxRedirects: 0,
    beforeRedirect: blockPrivateRedirect,
    httpAgent: new http.Agent({ lookup: safeLookup }),
    httpsAgent: new https.Agent({ lookup: safeLookup })
});

/**
 * Should this server's owner be told right now? Only the user's own settings decide that:
 * alerts must be switched on, and "now" must be inside their alert window.
 * (What happened - down, recovery, slow - is decided once, in the monitor worker.)
 */
export const shouldSendAlert = (server) => {
    if (!server.monitoring?.alerts?.enabled) return false;

    // Alert hours are the user's own clock, not the server's
    const window = server.monitoring?.alerts?.timeWindow;
    if (window?.start && window?.end) {
        const { time } = localParts(new Date(), timezoneOf(server));
        return timeInWindow(time, window.start, window.end);
    }

    return true;
};

/**
 * What to call a webhook in a log line: its host only. Slack, Discord and Teams webhook addresses carry a secret in
 * the path, and anyone who has the address can post to that channel.
 */
export const webhookLabel = (webhookUrl) => hostFromTarget(webhookUrl) || 'the configured webhook';

/**
 * Execute a webhook for the alert
 * @param {Object} server - Server data
 * @param {String} alertType - Type of alert
 * @param {Object} payload - Data to send
 */
const sendWebhookAlert = async (server, alertType, payload) => {
    const webhookUrl = server.monitoring?.alerts?.webhookUrl;
    if (!webhookUrl) return;

    logger.info(`Sending webhook for ${server.name} (${server._id}) to ${webhookLabel(webhookUrl)}`);

    await assertPublicHost(webhookUrl);

    await webhookClient.post(webhookUrl, {
        event: alertType,
        server: {
            id: server._id,
            name: server.name,
            url: server.url,
            status: server.status
        },
        ...payload,
        timestamp: new Date().toISOString()
    }, {
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'PingPilott-Webhook-Bot/1.0'
        }
    });

    logger.info(`Webhook sent successfully for ${server.name}`);
};

/**
 * A webhook failure that another attempt cannot fix: the address is private, or the receiver answered that the request
 * itself is wrong (404 gone, 401/403 refused, 400 bad). Timeouts, 408, 429 and 5xx are worth another try.
 */
export const isPermanentWebhookFailure = (error) => {
    if (error?.code === 'PRIVATE_TARGET') return true;
    const status = error?.response?.status;
    return Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
};

/**
 * Send the alert on each channel that still has to go out.
 * @param {Object} server - The server document; `status` is the status it moved away from
 * @param {String} alertType - 'server_down' | 'server_recovery' | 'slow_response'
 * @param {Object} checkResult - Result object
 * @param {{ email?: boolean, webhook?: boolean }} done - channels that already succeeded, which are not sent again
 * @param {{ sendEmail?: Function, sendWebhook?: Function }} senders - replaceable in tests
 * @returns {Promise<{ email: boolean, webhook: boolean, errors: Error[] }>}
 *   A channel is true when it was sent, was sent earlier, or has nothing to send (no contacts, no webhook, or a
 *   webhook that can never work). It never throws: one channel failing must not stop the other.
 */
export const sendAlertChannels = async (server, alertType, checkResult, done = {}, senders = {}) => {
    const { sendEmail = sendAlertEmail, sendWebhook = sendWebhookAlert } = senders;
    const result = { email: Boolean(done.email), webhook: Boolean(done.webhook), errors: [] };

    const enhancedServer = {
        ...(server.toObject ? server.toObject() : server),
        // Alerts go to people other than the account holder: never carry a password that was saved in the address
        url: maskCredentials(server.url),
        responseTime: checkResult.responseTime,
        error: checkResult.error,
        failureKind: checkResult.failureKind,
        statusCode: checkResult.statusCode,
        slowStreak: checkResult.slowStreak,
        timings: checkResult.timings,
        flap: checkResult.flap,
        cert: checkResult.cert,
        alertTime: new Date().toISOString()
    };

    const emailEnabled = server.monitoring?.alerts?.email ?? true;
    const webhookUrl = server.monitoring?.alerts?.webhookUrl;
    const newStatus = checkResult.status;
    const oldStatus = server.status;

    if (!result.email) {
        if (emailEnabled && server.contactEmails?.length > 0) {
            try {
                await sendEmail(enhancedServer, alertType, oldStatus, newStatus);
                result.email = true;
                logger.info(`🔔 Alert email sent for ${server.name}: ${alertType}`);
            } catch (error) {
                result.errors.push(error);
            }
        } else {
            result.email = true;
        }
    }

    const downDiagnosis = alertType === 'server_down'
        ? diagnose({ kind: checkResult.failureKind, statusCode: checkResult.statusCode, error: checkResult.error })
        : null;

    if (!result.webhook) {
        if (webhookUrl) {
            try {
                await sendWebhook(enhancedServer, alertType, {
                    oldStatus,
                    newStatus,
                    responseTime: checkResult.responseTime,
                    error: checkResult.error,
                    ...(cleanFlap(checkResult.flap) ? { flap: cleanFlap(checkResult.flap) } : {}),
                    // A certificate warning says when the certificate expires and what step it has reached
                    ...(alertType === 'cert_expiring' && cleanCert(checkResult.cert) ? { cert: cleanCert(checkResult.cert) } : {}),
                    ...(checkResult.failureKind ? { failureKind: checkResult.failureKind } : {}),
                    ...(Number.isInteger(checkResult.statusCode) ? { statusCode: checkResult.statusCode } : {}),
                    // A down alert also says it in plain words; the fields above are unchanged
                    ...(downDiagnosis ? { diagnosis: downDiagnosis } : {}),
                    ...(Number.isFinite(checkResult.slowStreak) ? { slowStreak: checkResult.slowStreak } : {}),
                    // A slow alert says where the time went; other alerts keep the payload they always had
                    ...(alertType === 'slow_response' && cleanTimings(checkResult.timings) ? { timings: cleanTimings(checkResult.timings) } : {})
                });
                result.webhook = true;
            } catch (error) {
                if (isPermanentWebhookFailure(error)) {
                    // Retrying a dead address for a day would only hide the email that did go out
                    logger.warn(`Webhook for ${server.name} (${server._id}) was refused and will not be retried: ${error.message}`);
                    result.webhook = true;
                } else {
                    result.errors.push(error);
                }
            }
        } else {
            result.webhook = true;
        }
    }

    return result;
};

export default { shouldSendAlert, sendAlertChannels, isPermanentWebhookFailure };
