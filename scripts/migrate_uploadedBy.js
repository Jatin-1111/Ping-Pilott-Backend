
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
dotenv.config({ path: path.join(process.cwd(), '.env') });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import Server from '../models/Server.js';

const migrate = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const servers = await Server.find({});
        console.log(`Found ${servers.length} servers to check/migrate.`);

        let updated = 0;
        for (const server of servers) {
            // Check if uploadedBy is a valid ObjectId string but maybe stored as string
            if (server.uploadedBy) {
                // If we re-save, Mongoose schema should cast it to ObjectId automatically
                // because we updated the schema to Schema.Types.ObjectId
                // We just need to mark it as modified to be sure, or just save.

                // Explicitly cast to ObjectId just in case
                const originalValue = server.uploadedBy;
                server.uploadedBy = new mongoose.Types.ObjectId(originalValue);

                await server.save();
                console.log(`Updated server ${server.name} (${server._id}): uploadedBy ${originalValue} -> ${server.uploadedBy}`);
                updated++;
            }
        }

        console.log(`Migration completed. Updated ${updated} servers.`);

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await mongoose.disconnect();
    }
};

migrate();
