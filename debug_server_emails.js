
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
        console.log("Connected to MongoDB");

        await Server.deleteOne({ name: "Email_Test_Server" });

        // 1. Create Server with emails
        const server = await Server.create({
            name: "Email_Test_Server",
            url: "http://email-test.com",
            uploadedBy: "test_user",
            contactEmails: ["initial@test.com"],
            monitoring: {
                alerts: {
                    enabled: true,
                    email: true
                }
            }
        });

        console.log("Created. Emails:", server.contactEmails);

        // 2. Fetch server via findById (simulate retrieval)
        const fetched = await Server.findById(server._id).lean();
        console.log("Fetched. Emails:", fetched.contactEmails);

        // 3. Update server emails (simulate update)
        const updates = {
            contactEmails: ["updated@test.com", "another@test.com"],
            "monitoring.alerts.email": true
        };

        const updated = await Server.findByIdAndUpdate(
            server._id,
            { $set: updates },
            { new: true }
        );
        console.log("Updated. Emails:", updated.contactEmails);

        // 4. Verify persistence
        const final = await Server.findById(server._id).lean();
        console.log("Final Fetch. Emails:", final.contactEmails);

        await Server.deleteOne({ _id: server._id });
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
};

run();
