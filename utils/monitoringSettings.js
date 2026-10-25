// utils/monitoringSettings.js - how the monitoring settings a user sends become what is stored
//
// Both routes copy the settings field by field, so a setting that is not listed here is silently dropped. They live in
// one place, away from the controller, so a test can send every setting through them and see it come out.

import { normalizeStatusSpec } from './statusSpec.js';
import { cleanKeyword } from './keyword.js';

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
        ...(monitoring.acceptedStatus ? { acceptedStatus: normalizeStatusSpec(monitoring.acceptedStatus) } : {}),
        ...(cleanKeyword(monitoring.keyword) ? { keyword: cleanKeyword(monitoring.keyword) } : {})
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

    // The text the page must contain (or must not). null takes the check away.
    if (validated?.keyword !== undefined) {
        updates['monitoring.keyword'] = validated.keyword === null ? null : cleanKeyword(validated.keyword);
    }

    // Limits for the host agent's alerts. Each number is saved on its own, so changing the CPU limit leaves the memory one
    // (and the defaults for anything never set) as they were.
    const host = validated?.hostAlerts;
    if (host) {
        if (host.enabled !== undefined) updates['monitoring.hostAlerts.enabled'] = host.enabled;
        for (const metric of ['cpu', 'memory', 'disk']) {
            for (const field of ['percent', 'minutes']) {
                if (host[metric]?.[field] !== undefined) updates[`monitoring.hostAlerts.${metric}.${field}`] = host[metric][field];
            }
        }
        if (host.missing?.minutes !== undefined) updates['monitoring.hostAlerts.missing.minutes'] = host.missing.minutes;
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
