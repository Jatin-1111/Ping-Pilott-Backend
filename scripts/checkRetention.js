// scripts/checkRetention.js - read-only: is old check history really being removed?
//
//   node scripts/checkRetention.js
//
// Connects with MONGO_URI (from .env) and only reads: the collection's options and indexes, and the oldest and newest
// check. It imports no model, so it cannot create a collection or an index. Prints a report; exits 1 when it found a
// problem. See services/retentionCheck.js.

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { inspectRetention, formatRetentionReport } from '../services/retentionCheck.js';
import { resolveRetentionDays } from '../utils/retention.js';

dotenv.config();

const uri = process.env.MONGO_URI;
if (!uri) {
    console.error('MONGO_URI is not set.');
    process.exit(2);
}

const client = new mongoose.mongo.MongoClient(uri, { serverSelectionTimeoutMS: 8000 });

try {
    await client.connect();
    // client.db() uses the database named in the connection string; without one it is "test", which is empty
    const db = client.db();
    console.log(`Database: ${db.databaseName}\n`);

    const { days } = resolveRetentionDays(process.env.CHECK_DATA_RETENTION_DAYS);
    const report = await inspectRetention({ db, retentionDays: days });
    console.log(formatRetentionReport(report));
    if (db.databaseName === 'test') console.log('\nThe connection string names no database, so this looked at "test". Add the database name after the host.');

    process.exitCode = report.warnings.length > 0 ? 1 : 0;
} catch (err) {
    console.error(`Could not check: ${err.message}`);
    process.exitCode = 2;
} finally {
    await client.close();
}
