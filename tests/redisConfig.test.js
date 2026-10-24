// Run with: npm test
// Regression test for "BullMQ: Your redis options maxRetriesPerRequest must be null" on every worker start in
// production. No Redis server is needed: clients are created with lazyConnect and never connect.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import { redisConnectionArgs } from '../config/redisOptions.js';

// Build a real ioredis client from the arguments without connecting, and report what BullMQ will see
const clientFor = (env) => {
    const [first, options] = redisConnectionArgs(env);
    const client = typeof first === 'string'
        ? new Redis(first, { ...options, lazyConnect: true })
        : new Redis({ ...first, lazyConnect: true });
    return client;
};

test('why it broke: ioredis given only a URL keeps 20 retries, which BullMQ workers refuse', () => {
    const client = new Redis('redis://localhost:6379', { lazyConnect: true });
    assert.equal(client.options.maxRetriesPerRequest, 20);
    client.disconnect();
});

test('with REDIS_URL set the connection still has maxRetriesPerRequest: null', () => {
    const client = clientFor({ REDIS_URL: 'redis://redis:6379' });
    assert.equal(client.options.maxRetriesPerRequest, null);
    assert.equal(client.options.enableReadyCheck, false);
    assert.equal(client.options.host, 'redis');
    assert.equal(client.options.port, 6379);
    client.disconnect();
});

test('a rediss:// URL keeps its TLS setting and the options', () => {
    const client = clientFor({ REDIS_URL: 'rediss://default:secret@example.com:6380' });
    assert.equal(client.options.maxRetriesPerRequest, null);
    assert.equal(client.options.host, 'example.com');
    assert.equal(client.options.port, 6380);
    assert.ok(client.options.tls, 'TLS stays on for rediss://');
    client.disconnect();
});

test('with host and port settings the connection has the same options', () => {
    const client = clientFor({ REDIS_HOST: 'cache.internal', REDIS_PORT: '6380', REDIS_PASSWORD: 'pw' });
    assert.equal(client.options.maxRetriesPerRequest, null);
    assert.equal(client.options.host, 'cache.internal');
    assert.equal(client.options.port, 6380);
    assert.equal(client.options.password, 'pw');
    client.disconnect();
});

test('with nothing set it falls back to a local Redis', () => {
    const client = clientFor({});
    assert.equal(client.options.maxRetriesPerRequest, null);
    assert.equal(client.options.host, 'localhost');
    assert.equal(client.options.port, 6379);
    client.disconnect();
});

test('reconnects back off 50ms per attempt up to 2 seconds', () => {
    const [, options] = redisConnectionArgs({ REDIS_URL: 'redis://x:6379' });
    assert.equal(options.retryStrategy(1), 50);
    assert.equal(options.retryStrategy(10), 500);
    assert.equal(options.retryStrategy(1000), 2000);
});
