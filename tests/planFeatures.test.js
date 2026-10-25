// Run with: npm test
// Free is a plan that never expires, and each plan's limits come from one place that the user model, the admin
// downgrade and the migration script all use.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planFeatures } from '../utils/planFeatures.js';
import User from '../models/User.js';
import { checkPlanLimits } from '../services/planLimits.js';

test('each plan has the limits the pricing page promises', () => {
    assert.deepEqual(planFeatures('free'), { maxServers: 5, minCheckFrequency: 5, advancedAlerts: false, apiAccess: false, prioritySupport: false, webhookIntegrations: false, historicalReporting: false });
    assert.equal(planFeatures('starter_monthly').maxServers, 20);
    assert.equal(planFeatures('starter_yearly').minCheckFrequency, 1, '1-minute checks start at Starter');
    assert.equal(planFeatures('starter_monthly').webhookIntegrations, true, 'webhooks start at Starter');
    assert.equal(planFeatures('pro_monthly').maxServers, 60);
    assert.equal(planFeatures('pro_yearly').advancedAlerts, true);
    assert.equal(planFeatures('pro_monthly').apiAccess, false);
    assert.equal(planFeatures('business_monthly').maxServers, 200);
    assert.equal(planFeatures('business_yearly').apiAccess, true);
});

test('an unknown or missing plan is treated as free, and a copy is returned each time', () => {
    assert.equal(planFeatures('mystery').maxServers, 5);
    assert.equal(planFeatures().maxServers, 5);
    const a = planFeatures('free');
    a.maxServers = 999;
    assert.equal(planFeatures('free').maxServers, 5);
});

test('a new user starts on the free plan with its limits, and the subscription is active, not a trial', () => {
    const user = new User({ email: 'a@example.com', password: 'x'.repeat(12), displayName: 'A' });
    assert.equal(user.subscription.plan, 'free');
    assert.equal(user.subscription.status, 'active');
    assert.equal(user.subscription.features.maxServers, 5);
    assert.equal(user.subscription.features.minCheckFrequency, 5);
    assert.equal(user.subscription.features.webhookIntegrations, false);
});

test('a paid user gets that plan\'s limits from the model defaults', () => {
    const user = new User({ email: 'b@example.com', password: 'x'.repeat(12), displayName: 'B', subscription: { plan: 'starter_monthly' } });
    assert.equal(user.subscription.features.maxServers, 20);
    assert.equal(user.subscription.features.minCheckFrequency, 1);
    assert.equal(user.subscription.features.webhookIntegrations, true);
});

test('webhooks and 1-minute checks follow the plan on the API too', () => {
    const user = (plan) => ({ role: 'user', subscription: { plan, features: planFeatures(plan) } });
    assert.match(checkPlanLimits(user('free'), { alerts: { webhookUrl: 'https://hooks.example/x' } }), /paid plan/);
    assert.equal(checkPlanLimits(user('starter_monthly'), { alerts: { webhookUrl: 'https://hooks.example/x' } }), null);
    assert.match(checkPlanLimits(user('free'), { frequency: 1 }), /5 minutes or slower/);
    assert.equal(checkPlanLimits(user('starter_monthly'), { frequency: 1 }), null);
});
