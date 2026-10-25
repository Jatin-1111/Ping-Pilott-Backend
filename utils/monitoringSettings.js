// utils/monitoringSettings.js - how the monitoring settings a user sends become what is stored
//
// Both routes copy the settings field by field, so a setting that is not listed here is silently dropped. They live in
// one place, away from the controller, so a test can send every setting through them and see it come out.

import { normalizeStatusSpec } from './statusSpec.js';

/**
 * Build monitoring configuration for a new server
 * @param {Object} monitoring  the validated settings
 */
export const buildMonitoringConfig = (monitoring, userRole, trialEnd) => {
    return {
        frequency: monitoring.frequency || 5,
        daysOfWeek: monitoring.daysOfWeek || [0, 1, 2, 3, 4, 5, 6],
        timeWindows: monitoring.timeWindows || [{ start: '00:00', end: '23:59' }],
        alerts: {
            enabled: monitoring.alerts?.enabled || false,
            email: monitoring.alerts?.email || false,
            phone: monitoring.alerts?.phone || false,
            webhookUrl: monitoring.alerts?.webhookUrl || '',
            responseThreshold: monitoring.alerts?.responseThreshold || 1000,
            timeWindow: monitoring.alerts?.timeWindow || { start: '00:00', end: '23:59' }
        },
        trialEndsAt: userRole === 'admin' ? null : trialEnd,
        // Only written when set: a server without it is checked the way every server always was
        ...(monitoring.acceptedStatus ? { acceptedStatus: normalizeStatusSpec(monitoring.acceptedStatus) } : {})
    };
};

/**
 * Build monitoring updates for patch operations
 * @param {Object} monitoring  the settings as sent (the existing fields are copied from here)
 * @param {Object} [validated] the same settings after validation: the newer fields are taken from here only
 */
export const buildMonitoringUpdates = (monitoring, validated = monitoring) => {
    const updates = {};

    if (monitoring.frequency !== undefined) {
        updates['monitoring.frequency'] = monitoring.frequency;
        // A new interval takes effect at the next scheduler run instead of after the old one runs out
        updates.nextCheckAt = null;
    }
    if (monitoring.daysOfWeek !== undefined) {
        updates['monitoring.daysOfWeek'] = monitoring.daysOfWeek;
    }
    if (monitoring.timeWindows !== undefined) {
        updates['monitoring.timeWindows'] = monitoring.timeWindows;
    }

    // Which status codes count as up. '' puts the server back on the default.
    if (validated?.acceptedStatus !== undefined) {
        updates['monitoring.acceptedStatus'] = normalizeStatusSpec(validated.acceptedStatus);
    }

    // Handle alerts
    if (monitoring.alerts) {
        Object.entries(monitoring.alerts).forEach(([key, value]) => {
            if (value !== undefined) {
                updates[`monitoring.alerts.${key}`] = value;
            }
        });
    }

    return updates;
};

export default { buildMonitoringConfig, buildMonitoringUpdates };
