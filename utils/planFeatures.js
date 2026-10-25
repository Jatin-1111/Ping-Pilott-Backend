// utils/planFeatures.js - what each plan includes: the one place the limits are written down
//
// The user model fills a subscription's features from these when the account is created or the plan changes, the admin
// downgrade uses them, and scripts/migrateFreePlan.js brings existing accounts in line. The dashboard shows the same
// numbers from its own copy (app/components/subscriptionPlans.js in the web app), so a change here needs a change there.
//
// Free is a plan, not a trial: it never expires.

const FEATURES = {
    free: {
        maxServers: 5,
        minCheckFrequency: 5,
        advancedAlerts: false,
        apiAccess: false,
        prioritySupport: false,
        webhookIntegrations: false,
        historicalReporting: false
    },
    starter: {
        maxServers: 20,
        minCheckFrequency: 1,
        advancedAlerts: false,
        apiAccess: false,
        prioritySupport: false,
        webhookIntegrations: true,
        historicalReporting: true
    },
    pro: {
        maxServers: 60,
        minCheckFrequency: 1,
        advancedAlerts: true,
        apiAccess: false,
        prioritySupport: true,
        webhookIntegrations: true,
        historicalReporting: true
    },
    business: {
        maxServers: 200,
        minCheckFrequency: 1,
        advancedAlerts: true,
        apiAccess: true,
        prioritySupport: true,
        webhookIntegrations: true,
        historicalReporting: true
    }
};

/**
 * @param {string} [plan]  'free', 'starter_monthly', 'pro_yearly', ... Anything unknown is treated as free.
 * @returns {Object} a fresh copy of the plan's features. Admin accounts are not a plan here: the user model sets them itself.
 */
export function planFeatures(plan = 'free') {
    const tier = String(plan).split('_')[0];
    return { ...(FEATURES[tier] || FEATURES.free) };
}

export default { planFeatures };
