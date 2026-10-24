// services/retentionCheck.js - is old check history really being removed? (read only)
//
// ServerCheck is a time-series collection with a TTL index on its time field, and a nightly job also deletes old rows.
// Whether MongoDB accepted that index, and whether the nightly delete works on a time-series collection, depends on
// the server version and could not be seen from the code. This looks at the collection itself: its options, its
// indexes, and the oldest and newest check, and says what it finds. It only reads: no write, no index, no command that
// changes anything. Used at start-up (one log line) and by scripts/checkRetention.js.

const COLLECTION = 'serverchecks';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {Object} p
 * @param {Object} p.db            a MongoDB Db (mongoose.connection.db, or client.db())
 * @param {number} p.retentionDays the configured retention (utils/retention.js)
 * @param {number} [p.now]
 * @returns {Promise<{ exists: boolean, facts: Object, warnings: string[] }>}
 */
export async function inspectRetention({ db, retentionDays, now = Date.now() }) {
    const warnings = [];
    const facts = { retentionDays };

    const [info] = await db.listCollections({ name: COLLECTION }).toArray();
    if (!info) {
        return { exists: false, facts, warnings: ['The serverchecks collection does not exist yet (no check has been saved).'] };
    }

    const collection = db.collection(COLLECTION);
    facts.timeSeries = Boolean(info.options?.timeseries);
    facts.collectionTtlSeconds = info.options?.expireAfterSeconds ?? null;

    const indexes = await collection.indexes();
    facts.ttlIndexes = indexes
        .filter((index) => index.expireAfterSeconds !== undefined)
        .map((index) => ({ name: index.name, key: index.key, expireAfterSeconds: index.expireAfterSeconds }));

    const [oldest] = await collection.find({}, { projection: { timestamp: 1 } }).sort({ timestamp: 1 }).limit(1).toArray();
    const [newest] = await collection.find({}, { projection: { timestamp: 1 } }).sort({ timestamp: -1 }).limit(1).toArray();
    facts.oldestCheck = oldest?.timestamp ? new Date(oldest.timestamp).toISOString() : null;
    facts.newestCheck = newest?.timestamp ? new Date(newest.timestamp).toISOString() : null;
    facts.oldestAgeDays = oldest?.timestamp ? Math.round(((now - new Date(oldest.timestamp).getTime()) / DAY_MS) * 10) / 10 : null;

    try {
        facts.serverVersion = (await db.admin().command({ buildInfo: 1 })).version;
    } catch {
        facts.serverVersion = null; // not allowed for this user: not needed
    }

    // Which TTL, if any, is in force: the collection's own, or an index on the check time
    const ttlSeconds = [facts.collectionTtlSeconds, ...facts.ttlIndexes.map((index) => index.expireAfterSeconds)]
        .filter((seconds) => Number.isFinite(seconds));
    facts.ttlDays = ttlSeconds.length > 0 ? Math.round((Math.min(...ttlSeconds) / 86400) * 10) / 10 : null;

    if (facts.ttlDays === null) {
        warnings.push('No TTL is set on serverchecks: only the nightly job removes old checks, so if it fails the collection grows without limit.');
    } else if (facts.ttlDays < retentionDays) {
        warnings.push(`The TTL on serverchecks deletes after ${facts.ttlDays} days, earlier than the ${retentionDays} days configured, so the longer history is never kept.`);
    }

    if (facts.oldestAgeDays !== null && facts.oldestAgeDays > retentionDays + 2) {
        warnings.push(`The oldest check is ${facts.oldestAgeDays} days old, more than the ${retentionDays} days to keep: neither the nightly job nor the TTL is removing old checks. Check the clean-up errors in the log.`);
    }

    if (facts.newestCheck && now - new Date(facts.newestCheck).getTime() > 60 * 60 * 1000) {
        warnings.push(`The newest check was saved at ${facts.newestCheck}, more than an hour ago.`);
    }

    return { exists: true, facts, warnings };
}

/** The result as lines of text, for the script */
export function formatRetentionReport({ exists, facts, warnings }) {
    const lines = [`Configured retention: ${facts.retentionDays} days`];
    if (exists) {
        lines.push(
            `MongoDB version:      ${facts.serverVersion ?? 'not visible'}`,
            `Time-series:          ${facts.timeSeries ? 'yes' : 'no'}`,
            `Collection TTL:       ${facts.collectionTtlSeconds === null ? 'none' : `${facts.collectionTtlSeconds} s`}`,
            `TTL indexes:          ${facts.ttlIndexes.length === 0 ? 'none' : facts.ttlIndexes.map((i) => `${i.name} (${i.expireAfterSeconds} s)`).join(', ')}`,
            `Effective TTL:        ${facts.ttlDays === null ? 'none' : `${facts.ttlDays} days`}`,
            `Oldest check:         ${facts.oldestCheck ?? 'none'}${facts.oldestAgeDays !== null ? ` (${facts.oldestAgeDays} days old)` : ''}`,
            `Newest check:         ${facts.newestCheck ?? 'none'}`
        );
    }
    lines.push('', warnings.length === 0 ? 'No problems found.' : `Problems found (${warnings.length}):`, ...warnings.map((w) => `  - ${w}`));
    return lines.join('\n');
}

export default { inspectRetention, formatRetentionReport };
