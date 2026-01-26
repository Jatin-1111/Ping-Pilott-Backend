import logger from '../utils/logger.js';
import { sendAlertEmail } from './emailService.js';
import ServerCheck from '../models/ServerCheck.js';

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

    // Flapping check: simple check against recent history
    if (statusChanged) {
        // Fetch last 5 checks
        const recentChecks = await ServerCheck.find({ serverId: server._id })
            .sort({ timestamp: -1 })
            .limit(5)
            .lean();

        // If we have mixed results recently, it might be flapping
        // For simplicity: if we have > 2 status changes in last 5 checks, suppress?
        // Let's keep it simple for now and rely on user settings (delay/retry handled by queue mostly)
    }

    return true;
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
        const enhancedServer = {
            ...server.toObject ? server.toObject() : server, // Handle mongoose doc or POJO
            responseTime: checkResult.responseTime,
            error: checkResult.error,
            alertTime: new Date().toISOString()
        };

        const emailEnabled = server.monitoring?.alerts?.email ?? true;

        if (emailEnabled && server.contactEmails?.length > 0) {
            await sendAlertEmail(enhancedServer, alertType, oldStatus, newStatus);
            logger.info(`🔔 Smart alert sent for ${server.name}: ${alertType}`);
        }

    } catch (error) {
        logger.error(`Failed to handle alerts for ${server.name}: ${error.message}`);
    }
};

export default { shouldSendAlert, handleAlerts };
