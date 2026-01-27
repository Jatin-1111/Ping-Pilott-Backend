
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Server from '../models/Server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load env vars
dotenv.config({ path: join(__dirname, '../.env') });

const migrate = async () => {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const servers = await Server.find({});
        console.log(`Found ${servers.length} servers to migrate`);

        let updatedCount = 0;

        for (const server of servers) {
            // Check if updates are needed
            let needsUpdate = false;

            // Check days of week
            if (!server.monitoring.daysOfWeek || server.monitoring.daysOfWeek.length < 7) {
                server.monitoring.daysOfWeek = [0, 1, 2, 3, 4, 5, 6];
                needsUpdate = true;
            }

            // Check time windows
            if (!server.monitoring.timeWindows || server.monitoring.timeWindows.length === 0 ||
                server.monitoring.timeWindows[0].start !== '00:00' || server.monitoring.timeWindows[0].end !== '23:59') {
                server.monitoring.timeWindows = [{ start: '00:00', end: '23:59' }];
                needsUpdate = true;
            }

            // Check alerts time window
            if (!server.monitoring.alerts) server.monitoring.alerts = {};
            if (!server.monitoring.alerts.timeWindow ||
                server.monitoring.alerts.timeWindow.start !== '00:00' || server.monitoring.alerts.timeWindow.end !== '23:59') {
                server.monitoring.alerts.timeWindow = { start: '00:00', end: '23:59' };
                needsUpdate = true;
            }

            if (needsUpdate) {
                await server.save();
                updatedCount++;
                console.log(`Updated server: ${server.name} (${server._id})`);
            }
        }

        console.log(`Migration completed. Updated ${updatedCount} servers.`);
        process.exit(0);

    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
};

migrate();
