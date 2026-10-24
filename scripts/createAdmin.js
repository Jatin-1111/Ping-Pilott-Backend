// scripts/createAdmin.js - Standalone script to create an admin account

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env from the backend root regardless of the directory the script is run from
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import mongoose from 'mongoose';
import User from '../models/User.js';
import readline from 'readline';

// Create readline interface for user input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Promisify readline question
const question = (query) => new Promise((resolve) => rl.question(query, resolve));

const createAdmin = async () => {
    try {
        console.log('🚀 Admin Account Creation Script\n');

        // Connect to MongoDB
        console.log('📡 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB\n');

        // Get admin details from user
        const email = await question('Enter admin email: ');
        const password = await question('Enter admin password (min 6 characters): ');
        const displayName = await question('Enter admin display name (optional): ');

        // Validate input
        if (!email || !email.includes('@')) {
            throw new Error('Invalid email address');
        }

        if (!password || password.length < 6) {
            throw new Error('Password must be at least 6 characters');
        }

        // Check if user already exists
        const existingUser = await User.findOne({ email: email.toLowerCase() });

        if (existingUser) {
            console.log('\n⚠️  User with this email already exists.');
            const makeAdmin = await question('Make this user an admin? (yes/no): ');

            if (makeAdmin.toLowerCase() === 'yes' || makeAdmin.toLowerCase() === 'y') {
                existingUser.role = 'admin';
                existingUser.emailVerified = true;
                existingUser.subscription.plan = 'admin';
                existingUser.subscription.status = 'unlimited';
                await existingUser.save();

                console.log('\n✅ User updated to admin successfully!');
                console.log('📧 Email:', existingUser.email);
                console.log('👤 Name:', existingUser.displayName || 'Not set');
                console.log('🔑 Role:', existingUser.role);
                console.log('📦 Plan:', existingUser.subscription.plan);
            } else {
                console.log('\n❌ Operation cancelled.');
            }
        } else {
            // Create new admin user
            const adminUser = new User({
                email: email.toLowerCase(),
                password: password,
                displayName: displayName || email.split('@')[0],
                role: 'admin',
                emailVerified: true,
                subscription: {
                    plan: 'admin',
                    status: 'unlimited',
                    startDate: new Date(),
                    features: {
                        maxServers: -1,
                        minCheckFrequency: 1,
                        maxCheckFrequency: -1,
                        advancedAlerts: true,
                        prioritySupport: true,
                        webhookIntegrations: true,
                        historicalReporting: true,
                        unlimitedMonitoring: true
                    }
                }
            });

            await adminUser.save();

            console.log('\n✅ Admin account created successfully!');
            console.log('📧 Email:', adminUser.email);
            console.log('👤 Name:', adminUser.displayName);
            console.log('🔑 Role:', adminUser.role);
            console.log('📦 Plan:', adminUser.subscription.plan);
            console.log('✉️  Email Verified:', adminUser.emailVerified);
        }

    } catch (error) {
        console.error('\n❌ Error:', error.message);
        if (error.code === 11000) {
            console.error('This email is already registered.');
        }
    } finally {
        rl.close();
        await mongoose.connection.close();
        console.log('\n📡 MongoDB connection closed.');
        process.exit(0);
    }
};

// Run the script
createAdmin();
