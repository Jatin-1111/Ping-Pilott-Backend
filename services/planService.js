// services/planService.js - the one way a user's plan changes
//
// A plan lives in three places: the user's subscription (plan + feature limits), each of the user's
// servers (`uploadedPlan`, which decides whether the free-trial cut-off applies), and the trial end date
// on those servers. Changing only the first - which is all the old admin PATCH did - left the user
// "Pro" on paper while their servers stayed trial-expired and stopped being checked.

import Server from '../models/Server.js';
import { invalidateServerCache } from '../utils/cacheManager.js';

export const PLAN_IDS = [
    'free',
    'starter_monthly', 'starter_yearly',
    'pro_monthly', 'pro_yearly',
    'business_monthly', 'business_yearly',
    'admin'
];

const DURATION_DAYS = { monthly: 30, yearly: 365 };

/**
 * Move a user to a plan and bring their servers in line.
 * @param {Document} user - Mongoose user document (not lean)
 * @param {string} plan - one of PLAN_IDS
 * @param {Object} [options] - { status, endDate, paymentId }
 */
export async function applyPlanChange(user, plan, options = {}) {
    if (!PLAN_IDS.includes(plan)) {
        throw Object.assign(new Error(`Invalid plan: ${plan}`), { statusCode: 400 });
    }

    const now = new Date();
    const billing = plan.split('_')[1];

    user.subscription.plan = plan;
    user.subscription.startDate = now;
    user.subscription.status = options.status || (plan === 'admin' ? 'unlimited' : 'active');
    user.subscription.endDate = options.endDate !== undefined
        ? options.endDate
        : (DURATION_DAYS[billing] ? new Date(now.getTime() + DURATION_DAYS[billing] * 24 * 60 * 60 * 1000) : null);
    if (options.paymentId) user.subscription.paymentId = options.paymentId;

    // The model's pre-save hook recomputes subscription.features from the plan
    await user.save();

    const serverUpdate = { uploadedPlan: plan };
    if (plan !== 'free') {
        // A paid plan has no trial cut-off: servers that expired on the free trial start being checked again
        serverUpdate['monitoring.trialEndsAt'] = null;
        serverUpdate.nextCheckAt = null;
        // ...and ones that were paused when the trial ended (services/trialPause.js) are resumed
        serverUpdate.pausedAt = null;
        serverUpdate.trialNoticeSentAt = null;
    }
    await Server.updateMany({ uploadedBy: user._id }, { $set: serverUpdate });
    await invalidateServerCache(user.id);

    return user;
}

export default { applyPlanChange, PLAN_IDS };
