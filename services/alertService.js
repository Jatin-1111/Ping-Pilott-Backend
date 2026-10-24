import logger from '../utils/logger.js';
import { sendAlertEmail } from './emailService.js';
import ServerCheck from '../models/ServerCheck.js';
import axios from 'axios';
import http from 'http';
import https from 'https';
import { safeLookup, assertPublicHost, blockPrivateRedirect } from '../utils/ssrfGuard.js';
import { localParts, timeInWindow, timezoneOf } from '../utils/schedule.js';

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
 * Execute a webhook for the alert
 * @param {Object} server - Server data
 * @param {String} alertType - Type of alert
 * @param {Object} payload - Data to send
 */
const sendWebhookAlert = async (server, alertType, payload) => {
    const webhookUrl = server.monitoring?.alerts?.webhookUrl;
    if (!webhookUrl) return;

    try {
        logger.info(`Sending webhook for ${server.name} (${server._id}) to ${webhookUrl}`);

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
    } catch (error) {
        logger.error(`Failed to send webhook for ${server.name}: ${error.message}`);
        // We could implement retry logic here or put it in a separate queue
    }
};

/**
 * Handle sending the alert
 * @param {Object} server - The server document (snapshot from when the status changed)
 * @param {String} alertType - 'server_down' | 'server_recovery' | 'slow_response'
 * @param {Object} checkResult - Result object
 *
 * Email failures are thrown, not swallowed: the alert queue retries with backoff, which is the whole
 * point of having a queue. The webhook runs after the email and never fails the job, so a retry cannot
 * send the same email twice because of a flaky webhook.
 */
export const handleAlerts = async (server, alertType, checkResult) => {
    if (!alertType || !shouldSendAlert(server)) return false;

    let delivered = false;

    const enhancedServer = {
        ...(server.toObject ? server.toObject() : server),
        responseTime: checkResult.responseTime,
        error: checkResult.error,
        alertTime: new Date().toISOString()
    };

    const emailEnabled = server.monitoring?.alerts?.email ?? true;
    const webhookUrl = server.monitoring?.alerts?.webhookUrl;
    const newStatus = checkResult.status;
    const oldStatus = server.status;

    if (emailEnabled && server.contactEmails?.length > 0) {
        await sendAlertEmail(enhancedServer, alertType, oldStatus, newStatus);
        delivered = true;
        logger.info(`🔔 Alert email sent for ${server.name}: ${alertType}`);
    }

    if (webhookUrl) {
        await sendWebhookAlert(enhancedServer, alertType, {
            oldStatus,
            newStatus,
            responseTime: checkResult.responseTime,
            error: checkResult.error
        });
        delivered = true;
    }

    return delivered;
};

export default { shouldSendAlert, handleAlerts };
