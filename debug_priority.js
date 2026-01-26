
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Server from './models/Server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '.env') });

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);

        // 1. Create Server with medium priority
        const server = await Server.create({
            name: "Priority_Test_Server",
            url: "http://priority-test.com",
            uploadedBy: "test_user",
            priority: "medium"
        });
        console.log(`Created server ${server._id} with priority: ${server.priority}`);

        // 2. Update to HIGH
        const updates = { priority: "high" };
        const updated = await Server.findByIdAndUpdate(
            server._id,
            { $set: updates },
            { new: true, runValidators: true }
        );
        console.log(`Updated priority to: ${updated.priority}`);

        // 3. Verify persistence
        const fetched = await Server.findById(server._id).lean();
        console.log(`Fetched priority: ${fetched.priority}`);

        if (fetched.priority !== 'high') {
            console.error("FAIL: Priority did not persist as 'high'");
        } else {
            console.log("SUCCESS: Priority persisted correctly");
        }

        await Server.deleteOne({ _id: server._id });
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
};

run();
