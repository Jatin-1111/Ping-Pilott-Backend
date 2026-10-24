// scripts/setRetentionTtl.js - give the serverchecks collection a 30 day TTL
//
//   node scripts/setRetentionTtl.js            shows what it would change and changes nothing
//   node scripts/setRetentionTtl.js --apply    sets the TTL (MongoDB collMod: no data is touched, nothing is rebuilt)
//
// Connects with MONGO_URI (from .env, or from your shell, which wins). Imports no model. After this, MongoDB deletes
// checks older than 30 days by itself, in the background, as a backstop to the nightly job. Run
// scripts/checkRetention.js before and after to see the state.

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { planTtlChange, applyTtlChange } from '../services/retentionFix.js';

dotenv.config();

const apply = process.argv.includes('--apply');
const uri = process.env.MONGO_URI;
if (!uri) {
    console.error('MONGO_URI is not set.');
    process.exit(2);
}

const client = new mongoose.mongo.MongoClient(uri, { serverSelectionTimeoutMS: 8000 });

try {
    await client.connect();
    const db = client.db();
    console.log(`Database: ${db.databaseName}`);
    if (db.databaseName === 'test') console.log('The connection string names no database, so this is "test". Add the database name after the host.');

    const [info] = await db.listCollections({ name: 'serverchecks' }).toArray();
    const plan = planTtlChange({ info });
    console.log(plan.reason);

    if (plan.action !== 'set') {
        process.exitCode = plan.action === 'cannot' ? 1 : 0;
    } else if (!apply) {
        console.log('\nNothing was changed. Run again with --apply to make the change.');
    } else {
        await applyTtlChange({ db });
        const [after] = await db.listCollections({ name: 'serverchecks' }).toArray();
        console.log(`\nDone: the TTL is now ${after?.options?.expireAfterSeconds} seconds.`);
    }
} catch (err) {
    console.error(`Failed: ${err.message}`);
    process.exitCode = 2;
} finally {
    await client.close();
}
