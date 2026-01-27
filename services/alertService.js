import logger from '../utils/logger.js';
import { sendAlertEmail } from './emailService.js';
import ServerCheck from '../models/ServerCheck.js';
import axios from 'axios';

/**
 * Check if we should send an alert based on smart logic
 * @param {Object} server - The server document
 * @param {String} oldStatus - Previous status (up/down)
 * @param {String} newStatus - New status (up/down)
 * @param {Object} checkResult - Result object (error, responseTime)
 * @returns {Boolean} - Whether to send alert
 */
export const shouldSendAlert = async (server, oldStatus, newStatus, checkResult) => {
    // Basic checks
    if (!server.monitoring?.alerts?.enabled) return false;

    const statusChanged = oldStatus !== newStatus;
    const hasSlowResponse = newStatus === 'up' && checkResult.error?.includes('Slow response');

    if (!statusChanged && !hasSlowResponse) return false;

    const now = new Date();

    // Check time window for alerts
    const alertTimeWindow = server.monitoring?.alerts?.timeWindow;
    if (alertTimeWindow?.start && alertTimeWindow?.end) {
        // 00:00 to 00:00 means 24/7 alerts
        if (alertTimeWindow.start === '00:00' && alertTimeWindow.end === '00:00') {
            // Allowed
        } else {
            const currentTime = now.getHours().toString().padStart(2, '0') + ':' +
                now.getMinutes().toString().padStart(2, '0');

            if (alertTimeWindow.start <= alertTimeWindow.end) {
                // Standard window
                if (currentTime < alertTimeWindow.start || currentTime > alertTimeWindow.end) {
                    return false;
                }
            } else {
                // Overnight window (e.g. 23:00 to 07:00)
                // If NOT in start-to-midnight AND NOT in midnight-to-end, then we are outside
                if (currentTime < alertTimeWindow.start && currentTime > alertTimeWindow.end) {
                    return false;
                }
            }
        }
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

        await axios.post(webhookUrl, {
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
            timeout: 5000, // 5s timeout for webhooks
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
 * @param {Object} server - The server document
 * @param {String} oldStatus - Previous status
 * @param {String} newStatus - New status
 * @param {Object} checkResult - Result object
 */
export const handleAlerts = async (server, oldStatus, newStatus, checkResult) => {
    try {
        const shouldSend = await shouldSendAlert(server, oldStatus, newStatus, checkResult);
        if (!shouldSend) return;

        let alertType;

        if (oldStatus === 'up' && newStatus === 'down') {
            alertType = 'server_down';
        } else if (oldStatus !== 'up' && newStatus === 'up') {
            alertType = 'server_recovery';
        } else if (checkResult.error?.includes('Slow response')) {
            alertType = 'slow_response';
        } else {
            return;
        }

        // Enhanced server object for email
        // Logic to handle if server is mongoose doc or POJO
        const serverObj = server.toObject ? server.toObject() : server;
        const enhancedServer = {
            ...serverObj,
            responseTime: checkResult.responseTime,
            error: checkResult.error,
            alertTime: new Date().toISOString()
        };

        const emailEnabled = server.monitoring?.alerts?.email ?? true;
        const webhookUrl = server.monitoring?.alerts?.webhookUrl;

        // Send Email
        if (emailEnabled && server.contactEmails?.length > 0) {
            await sendAlertEmail(enhancedServer, alertType, oldStatus, newStatus);
            logger.info(`🔔 Smart alert email sent for ${server.name}: ${alertType}`);
        }

        // Send Webhook (Fire and Forget)
        if (webhookUrl) {
            // Non-blocking call
            sendWebhookAlert(enhancedServer, alertType, {
                oldStatus,
                newStatus,
                responseTime: checkResult.responseTime,
                error: checkResult.error
            });
        }

    } catch (error) {
        logger.error(`Failed to handle alerts for ${server.name}: ${error.message}`);
    }
};

export default { shouldSendAlert, handleAlerts };
