// scripts/workerHealthcheck.js - exit 0 when this container's worker has a live heartbeat, 1 when it does not
//
//   node scripts/workerHealthcheck.js monitor
//   node scripts/workerHealthcheck.js alert
//
// For a container healthcheck (docker-compose.yml). It reads Redis only and touches no database or model.

import os from 'os';
import { Redis } from 'ioredis';
import { beatPattern, ROLES } from '../utils/healthKeys.js';

const role = process.argv[2];
if (!ROLES.includes(role)) {
    console.error(`Usage: node scripts/workerHealthcheck.js <${ROLES.join('|')}>`);
    process.exit(2);
}

const redis = new Redis(process.env.REDIS_URL || {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
}, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000, retryStrategy: () => null });

// Failures are reported by the catch below; without a listener ioredis also prints an "unhandled error event"
redis.on('error', () => {});

// Never hang a healthcheck
const giveUp = setTimeout(() => {
    console.error('Redis did not answer in time');
    process.exit(1);
}, 6000);

try {
    await redis.connect();
    const pattern = beatPattern(role, os.hostname());
    let cursor = '0';
    let found = false;
    do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = next;
        if (keys.length > 0) found = true;
    } while (cursor !== '0' && !found);

    clearTimeout(giveUp);
    redis.disconnect();
    if (!found) console.error(`No live ${role} worker heartbeat for host ${os.hostname()}`);
    process.exit(found ? 0 : 1);
} catch (err) {
    console.error(`Healthcheck failed: ${err.message}`);
    process.exit(1);
}
