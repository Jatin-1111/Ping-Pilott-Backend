
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
dotenv.config({ path: path.join(process.cwd(), '.env') });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import Server from '../models/Server.js';
import User from '../models/User.js';

const diagnose = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const servers = await Server.find({}).lean();
        const users = await User.find({}).lean();

        console.log(`Found ${users.length} users:`);
        users.forEach(u => console.log(` - [${u._id}] ${u.email} (${u.role})`));

        console.log(`\nFound ${servers.length} servers:`);
        for (const s of servers) {
            const owner = users.find(u => u._id.toString() === s.uploadedBy.toString());
            console.log(` - [${s._id}] "${s.name}"`);
            console.log(`   uploadedBy: ${s.uploadedBy} (Type: ${typeof s.uploadedBy})`);
            console.log(`   Owner found? ${owner ? 'YES (' + owner.email + ')' : 'NO (Orphaned)'}`);
        }

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await mongoose.disconnect();
    }
};

diagnose();
