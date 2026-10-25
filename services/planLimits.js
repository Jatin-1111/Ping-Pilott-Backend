// services/planLimits.js - plan rules enforced by the API, not just by the UI
//
// The dashboard hides what a plan does not include, but anyone can call the API directly. These checks
// make the limits real: a free user could otherwise set 1-minute checks and webhooks with one request.

import { isChatWebhook } from '../utils/chatWebhook.js';

/**
 * @param {Object} user - the authenticated user (req.user)
 * @param {Object} monitoring - the monitoring object from the request body
 * @returns {string|null} a message for the user, or null when everything is allowed
 */
export function checkPlanLimits(user, monitoring) {
    if (!monitoring || user.role === 'admin') return null;

    const features = user.subscription?.features || {};
    const plan = user.subscription?.plan || 'free';

    const minFrequency = features.minCheckFrequency || 5;
    if (monitoring.frequency !== undefined && monitoring.frequency < minFrequency) {
        return `Your ${plan.replace('_', ' ')} plan checks every ${minFrequency} minute${minFrequency === 1 ? '' : 's'} or slower. Choose ${minFrequency} or more, or upgrade for faster checks.`;
    }

    // Slack, Discord and Telegram addresses work on every plan; any other webhook is a paid feature
    if (monitoring.alerts?.webhookUrl && !features.webhookIntegrations && !isChatWebhook(monitoring.alerts.webhookUrl)) {
        return 'Slack, Discord and Telegram alerts are free on every plan. Other webhooks need a paid plan (Starter or above).';
    }

    return null;
}

export default { checkPlanLimits };
