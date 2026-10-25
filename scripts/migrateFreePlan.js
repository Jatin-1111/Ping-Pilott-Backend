// scripts/migrateFreePlan.js - bring existing accounts in line with the permanent free plan and the new plan limits
//
// Run after deploying the code that makes free a plan instead of a 2-day trial (utils/planFeatures.js):
//   node scripts/migrateFreePlan.js            shows what would change and writes nothing
//   node scripts/migrateFreePlan.js --apply    makes the changes
//
// What it does:
//   1. every non-admin user gets the features of the plan they are on (monitor limit, check interval, webhooks, ...),
//      because a user's features are stored on the account and were set when it was created
//   2. free users' subscriptions stop being a trial: status "active", no end date
//   3. free servers lose their trial end date and are un-paused, so ones the old trial stopped start being checked again
//
// Safe to run twice: it sets values, it does not add to them.

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env') });

import User from '../models/User.js';
import Server from '../models/Server.js';
import { planFeatures } from '../utils/planFeatures.js';

const APPLY = process.argv.includes('--apply');
const TIERS = ['free', 'starter', 'pro', 'business'];

// A plan id is "free" or "<tier>_monthly|yearly"
const planFilter = (tier) => (tier === 'free'
    ? { 'subscription.plan': 'free' }
    : { 'subscription.plan': new RegExp(`^${tier}_`) });

const featureUpdate = (tier) => Object.fromEntries(
    Object.entries(planFeatures(tier)).map(([key, value]) => [`subscription.features.${key}`, value])
);

const run = async () => {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set (looked in .env in the current folder)');
    await mongoose.connect(process.env.MONGO_URI);
    console.log(`${APPLY ? 'APPLYING' : 'DRY RUN (nothing is written; pass --apply to change data)'}\n`);

    for (const tier of TIERS) {
        const filter = { role: { $ne: 'admin' }, ...planFilter(tier) };
        const count = await User.countDocuments(filter);
        console.log(`${tier}: ${count} user(s) get ${JSON.stringify(planFeatures(tier))}`);
        if (APPLY && count > 0) await User.updateMany(filter, { $set: featureUpdate(tier) });
    }

    const freeUsers = { role: { $ne: 'admin' }, 'subscription.plan': 'free', 'subscription.status': { $ne: 'active' } };
    const trialUsers = await User.countDocuments(freeUsers);
    console.log(`\nfree users not "active" (trial, expired): ${trialUsers}`);
    if (APPLY && trialUsers > 0) {
        await User.updateMany(freeUsers, { $set: { 'subscription.status': 'active', 'subscription.endDate': null } });
    }

    const freeServers = { uploadedPlan: 'free', uploadedRole: { $ne: 'admin' }, $or: [{ 'monitoring.trialEndsAt': { $ne: null } }, { pausedAt: { $ne: null } }] };
    const servers = await Server.countDocuments(freeServers);
    console.log(`free servers with a trial end date or paused: ${servers}`);
    if (APPLY && servers > 0) {
        await Server.updateMany(freeServers, {
            $set: { 'monitoring.trialEndsAt': null, pausedAt: null, trialNoticeSentAt: null, nextCheckAt: null }
        });
    }

    console.log(APPLY ? '\nDone.' : '\nNothing changed. Run again with --apply to make these changes.');
    await mongoose.disconnect();
};

run().catch(async (error) => {
    console.error(`Migration failed: ${error.message}`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
