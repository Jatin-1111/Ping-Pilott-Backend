// Run with: npm test
// What has to be true for the API to run as more than one instance: the scheduler can be its own process and the API notices
// when it is gone, and every rate limiter has its own name (the Redis key prefix). No database or Redis.

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePipeline, STARTUP_GRACE_MS } from '../services/pipelineHealth.js';
import { countSchedulers } from '../utils/workerHealth.js';
import { beatPattern, beatKey, ROLES } from '../utils/healthKeys.js';

const NOW = 10_000_000;
const healthy = {
    now: NOW, startedAt: NOW - 60 * 60 * 1000, schedulerStatus: 'ok',
    monitorWorkers: 1, alertWorkers: 1, lastCheckCompletedAt: NOW - 5000, dispatches: []
};

test('with the scheduler in its own process, no heartbeat from it is reported', () => {
    const result = evaluatePipeline({ ...healthy, schedulers: 0 });
    assert.deepEqual(result.reasons, ['no-scheduler']);
    assert.equal(result.state, 'degraded');
});

test('with the scheduler in its own process and one beating, monitoring is ok', () => {
    assert.deepEqual(evaluatePipeline({ ...healthy, schedulers: 1 }), { state: 'ok', reasons: [] });
});

test('when the scheduler runs inside the API nothing is said about a separate one', () => {
    // schedulers is only looked up when RUN_SCHEDULER=false; left out, the rule is the one it always was
    assert.deepEqual(evaluatePipeline(healthy), { state: 'ok', reasons: [] });
});

test('right after a restart a missing scheduler is "starting", not an alarm', () => {
    const result = evaluatePipeline({ ...healthy, schedulers: 0, startedAt: NOW - (STARTUP_GRACE_MS - 1000) });
    assert.equal(result.state, 'starting');
    assert.deepEqual(result.reasons, ['no-scheduler']);
});

test('the scheduler has its own heartbeat role, so a container healthcheck can look for it', () => {
    assert.ok(ROLES.includes('scheduler'));
    assert.equal(beatKey('scheduler', 'host:1'), 'pp:health:scheduler-worker:host:1');
    assert.equal(beatPattern('scheduler'), 'pp:health:scheduler-worker:*');
});

test('countSchedulers counts only scheduler heartbeats', async () => {
    const keys = ['pp:health:scheduler-worker:a:1', 'pp:health:scheduler-worker:b:2', 'pp:health:monitor-worker:a:3'];
    const redis = {
        async scan(cursor, _match, pattern) {
            const prefix = pattern.replace('*', '');
            return ['0', keys.filter((k) => k.startsWith(prefix))];
        }
    };
    assert.equal(await countSchedulers(redis), 2);
});

test('every rate limiter is created with a name that is unique', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../middleware/rateLimiter.js', import.meta.url), 'utf8');
    const names = [...source.matchAll(/^export const \w+Limiter = create\w*RateLimiter\(\{\s*\n\s*name: '(\w+)'/gm)].map((m) => m[1]);
    const limiters = [...source.matchAll(/^export const \w+Limiter = create\w*RateLimiter\(/gm)];
    assert.equal(names.length, limiters.length, 'a limiter has no name');
    assert.equal(new Set(names).size, names.length, `duplicate limiter name in ${names.join(', ')}`);
});

test('a limiter without a name is refused, so no two can share a Redis prefix', async () => {
    // createRateLimiter is not exported; the user-limiter factory shares its name handling
    const { createUserRateLimiter } = await import('../middleware/rateLimiter.js');
    assert.throws(() => createUserRateLimiter({ max: 1 }), /needs a name/);
    assert.equal(typeof createUserRateLimiter({ name: 'probe', max: 1 }), 'function');
});
