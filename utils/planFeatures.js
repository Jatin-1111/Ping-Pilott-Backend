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

// Public status pages: how many a plan can have, and whether its pages carry the "Powered by Ping Pilott" footer.
// Kept apart from FEATURES because these are looked up when needed and are not stored on the user.
const STATUS_PAGES = {
    free: { pages: 1, branded: true },
    starter: { pages: 1, branded: true },
    pro: { pages: 3, branded: false },
    business: { pages: 10, branded: false }
};

/**
 * @param {string} [plan]
 * @returns {{ pages: number, branded: boolean }}  an unknown plan is treated as free
 */
export function statusPageAllowance(plan = 'free') {
    const tier = String(plan).split('_')[0];
    return { ...(STATUS_PAGES[tier] || STATUS_PAGES.free) };
}

// The detailed diagnosis of a failed check (causes, things to check, what the server said). Free accounts keep the plain
// one-line diagnosis, the step that failed and the timings. Kept apart from FEATURES, like the status pages: it is looked
// up by plan when a failure is shown, so accounts that already exist need no change to get it.
const DETAILED_DIAGNOSIS = { free: false, starter: true, pro: true, business: true };

/**
 * @param {{ role?: string, subscription?: { plan?: string } }|null|undefined} user
 * @returns {boolean}  admins always; otherwise by plan, and an unknown plan is treated as free
 */
export function hasDetailedDiagnosis(user) {
    if (user?.role === 'admin') return true;
    const tier = String(user?.subscription?.plan || 'free').split('_')[0];
    return DETAILED_DIAGNOSIS[tier] === true;
}

export default { planFeatures, statusPageAllowance, hasDetailedDiagnosis };
