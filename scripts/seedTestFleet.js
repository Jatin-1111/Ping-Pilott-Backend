// scripts/seedTestFleet.js - Create a test admin with a fleet of real, public servers (local development only)
//
// Usage:  node scripts/seedTestFleet.js
// Re-running is safe: the admin and servers are looked up first, and the fleet's recent check history is rebuilt.
// Override the login with TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD.

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import mongoose from 'mongoose';
import User from '../models/User.js';
import Server from '../models/Server.js';
import ServerCheck from '../models/ServerCheck.js';

const EMAIL = (process.env.TEST_ADMIN_EMAIL || 'testadmin@pingpilott.local').toLowerCase();
const PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'TestAdmin#2026';

// `expect` decides the seeded history: up (healthy), slow (up but over its threshold), down (failing, with the error)
// All of these are real public endpoints, so the running workers produce genuine results for them too.
const FLEET = [
    { name: 'Google', url: 'https://www.google.com', type: 'website', priority: 'high', expect: 'up', base: 120 },
    { name: 'GitHub', url: 'https://github.com', type: 'website', priority: 'high', expect: 'up', base: 260 },
    { name: 'Cloudflare', url: 'https://www.cloudflare.com', type: 'website', priority: 'high', expect: 'up', base: 140 },
    { name: 'Wikipedia', url: 'https://www.wikipedia.org', type: 'website', priority: 'medium', expect: 'up', base: 210 },
    { name: 'Mozilla', url: 'https://www.mozilla.org', type: 'website', priority: 'low', expect: 'up', base: 330 },
    { name: 'Example.com', url: 'https://example.com', type: 'website', priority: 'low', expect: 'up', base: 150 },
    { name: 'npm Registry', url: 'https://registry.npmjs.org', type: 'api', priority: 'high', expect: 'up', base: 180 },
    { name: 'GitHub API', url: 'https://api.github.com', type: 'api', priority: 'high', expect: 'up', base: 230 },
    { name: 'JSONPlaceholder API', url: 'https://jsonplaceholder.typicode.com/posts/1', type: 'api', priority: 'medium', expect: 'up', base: 190 },
    { name: 'Cat Facts API', url: 'https://catfact.ninja/fact', type: 'api', priority: 'low', expect: 'up', base: 420 },
    { name: 'Public IP API', url: 'https://api.ipify.org?format=json', type: 'api', priority: 'low', expect: 'up', base: 170 },
    { name: 'Cloudflare DNS (TCP 443)', url: '1.1.1.1:443', type: 'tcp', priority: 'medium', expect: 'up', base: 25 },
    { name: 'Google DNS (TCP 53)', url: '8.8.8.8:53', type: 'tcp', priority: 'medium', expect: 'up', base: 30 },
    { name: 'httpbin Slow Endpoint (3s)', url: 'https://httpbin.org/delay/3', type: 'api', priority: 'medium', expect: 'slow', base: 3300 },
    { name: 'httpbin Always 503', url: 'https://httpbin.org/status/503', type: 'api', priority: 'high', expect: 'down', base: 300, error: 'HTTP 503 Service Unavailable', failureKind: 'http', statusCode: 503 },
    { name: 'Expired TLS Certificate', url: 'https://expired.badssl.com', type: 'website', priority: 'medium', expect: 'down', base: 0, error: 'certificate has expired', failureKind: 'tls' },
    { name: 'Closed Port (TCP)', url: 'example.com:81', type: 'tcp', priority: 'low', expect: 'down', base: 0, error: 'Connection timed out', failureKind: 'timeout' }
];

const CHECK_INTERVAL_MIN = 15;
const HISTORY_HOURS = 24;

const jitter = (base, spread = 0.25) => Math.max(5, Math.round(base * (1 + (Math.random() * 2 - 1) * spread)));

function buildHistory(serverId, spec, now) {
    const rows = [];
    const steps = (HISTORY_HOURS * 60) / CHECK_INTERVAL_MIN;
    // A healthy server gets one short blip so its chart is not a flat line; a failing one has been down for most of the day
    const blipAt = spec.expect === 'up' && spec.priority === 'high' ? 40 : -1;
    for (let i = steps; i >= 0; i--) {
        const timestamp = new Date(now - i * CHECK_INTERVAL_MIN * 60 * 1000);
        const failing = spec.expect === 'down' ? i < steps - 6 : i === blipAt;
        if (failing) {
            rows.push({
                serverId, timestamp, status: 'down', responseTime: spec.base ? jitter(spec.base) : null,
                error: spec.error || 'Request timed out', failureKind: spec.failureKind || 'timeout',
                statusCode: spec.statusCode, checkType: 'automated'
            });
        } else {
            const responseTime = jitter(spec.base);
            rows.push({
                serverId, timestamp, status: 'up', responseTime, serverTime: Math.round(responseTime * 0.6),
                timings: { dns: jitter(15), connect: jitter(25), tls: jitter(40), ttfb: Math.round(responseTime * 0.6), redirects: 0 },
                checkType: 'automated'
            });
        }
    }
    return rows;
}

const run = async () => {
    const uri = process.env.MONGO_URI || '';
    // This script writes fake users and history, so it must never touch a shared or production database
    if (!/^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri)) {
        throw new Error(`Refusing to seed: MONGO_URI is not a local database (${uri.replace(/\/\/.*@/, '//***@')})`);
    }
    await mongoose.connect(uri);
    console.log('Connected to', mongoose.connection.name);

    // Admin: the model's pre-save hook fills in the admin plan and unlimited features
    let admin = await User.findOne({ email: EMAIL });
    if (admin) {
        admin.role = 'admin';
        admin.emailVerified = true;
        admin.password = PASSWORD;
        await admin.save();
        console.log('Updated existing admin', EMAIL);
    } else {
        admin = await User.create({ email: EMAIL, password: PASSWORD, displayName: 'Test Admin', role: 'admin', emailVerified: true });
        console.log('Created admin', EMAIL);
    }

    const now = Date.now();
    let created = 0;
    for (const spec of FLEET) {
        const isDown = spec.expect === 'down';
        const isSlow = spec.expect === 'slow';
        const lastResponse = spec.base ? jitter(spec.base, 0.1) : null;
        const fields = {
            name: spec.name,
            type: spec.type,
            description: `Test fleet: ${spec.expect === 'up' ? 'healthy public endpoint' : isSlow ? 'deliberately slow endpoint' : 'deliberately failing endpoint'}`,
            priority: spec.priority,
            timezone: 'UTC',
            uploadedBy: admin._id,
            uploadedRole: 'admin',
            uploadedPlan: 'admin',
            status: isDown ? 'down' : 'up',
            lastChecked: new Date(now - 2 * 60 * 1000),
            lastStatusChange: new Date(now - (isDown ? 5 : 24) * 60 * 60 * 1000),
            alertedStatus: isDown ? 'down' : null,
            responseTime: isDown ? null : lastResponse,
            serverTime: isDown || !lastResponse ? null : Math.round(lastResponse * 0.6),
            error: isDown ? spec.error : null,
            failureKind: isDown ? spec.failureKind : null,
            nextCheckAt: new Date(now + CHECK_INTERVAL_MIN * 60 * 1000),
            contactEmails: [EMAIL],
            monitoring: {
                frequency: 5,
                alerts: { enabled: true, email: true, responseThreshold: isSlow ? 2000 : 1000 }
            }
        };
        let server = await Server.findOne({ uploadedBy: admin._id, url: spec.url });
        if (server) {
            Object.assign(server, fields);
            await server.save();
        } else {
            server = await Server.create({ ...fields, url: spec.url });
            created++;
        }
        await ServerCheck.deleteMany({ serverId: server._id });
        await ServerCheck.insertMany(buildHistory(server._id, spec, now));
        console.log(`  ${isDown ? 'DOWN' : isSlow ? 'SLOW' : 'UP  '}  ${spec.name}`);
    }

    console.log(`\nDone: ${FLEET.length} servers (${created} new) for ${EMAIL}`);
    console.log('Password: set by TEST_ADMIN_PASSWORD, or the default in scripts/seedTestFleet.js');
};

run()
    .catch((err) => { console.error('Seed failed:', err.message); process.exitCode = 1; })
    .finally(() => mongoose.connection.close());
