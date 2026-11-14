// Run with: npm test
// Settings that were easy to get wrong without noticing: how many MongoDB connections each process may open, the start-up notice
// about e-mail verification, and the Node version the image and the pipeline use. No database.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { poolSize } from '../config/db.js';
import { emailVerificationNotice } from '../utils/emailVerification.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('a process may open 50 MongoDB connections unless told otherwise', () => {
    assert.equal(poolSize({}), 50);
    assert.equal(poolSize({ MONGO_MAX_POOL_SIZE: '10' }), 10);
});

test('a bad MONGO_MAX_POOL_SIZE falls back to the default instead of becoming 0 or NaN', () => {
    for (const bad of ['', 'abc', '0', '-5', undefined]) assert.equal(poolSize({ MONGO_MAX_POOL_SIZE: bad }), 50);
});

test('the pool is smaller than the old 100 per process, so several processes fit a small cluster', () => {
    // API + monitor worker + alert worker + scheduler at the default must stay under the smallest Atlas tier's 500
    assert.ok(poolSize({}) * 4 < 500);
});

test('production says so at start-up when e-mail verification is off', () => {
    assert.match(emailVerificationNotice({ NODE_ENV: 'production' }), /Email verification is OFF/);
    assert.match(emailVerificationNotice({ NODE_ENV: 'production', REQUIRE_EMAIL_VERIFICATION: 'false' }), /OFF/);
});

test('no notice when verification is on, or outside production', () => {
    assert.equal(emailVerificationNotice({ NODE_ENV: 'production', REQUIRE_EMAIL_VERIFICATION: 'true' }), null);
    assert.equal(emailVerificationNotice({ NODE_ENV: 'development' }), null);
    assert.equal(emailVerificationNotice({}), null);
});

test('the image and the pipeline use the same, supported Node version', () => {
    const image = Number(read('Dockerfile').match(/^FROM node:(\d+)/m)?.[1]);
    const pipeline = [...read('Jenkinsfile').matchAll(/image 'node:(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(image >= 22, `the Dockerfile uses Node ${image}`);
    assert.ok(pipeline.length >= 1);
    assert.ok(pipeline.every((v) => v === image), `pipeline Node ${pipeline} differs from the Dockerfile's ${image}`);
});

test('the pipeline runs the tests and the dependency audit', () => {
    const jenkinsfile = read('Jenkinsfile');
    assert.match(jenkinsfile, /npm test/);
    assert.match(jenkinsfile, /npm audit --omit=dev/);
});

test('package.json states the Node it needs', () => {
    const { engines } = JSON.parse(read('package.json'));
    assert.match(engines.node, /22/);
});
