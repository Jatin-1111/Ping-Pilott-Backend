// Run with: npm test
// The log line must carry what the caller passed (error details, metadata), never a secret, and no colour codes.
// Regression for: "Redis connection error:" logged 2,440 times with no reason, and a health warning with no issues.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Transport from 'winston-transport';
import winston from 'winston';
import logger, { logFormat, redact } from '../utils/logger.js';
import { throttled, suppressedNote } from '../utils/logThrottle.js';

// A logger built on the real format that keeps its lines in memory
const capture = () => {
    const lines = [];
    class Memory extends Transport {
        log(info, next) {
            lines.push(info[Symbol.for('message')]);
            next();
        }
    }
    const log = winston.createLogger({ level: 'debug', format: logFormat, transports: [new Memory()] });
    return { log, lines };
};

test('an error passed as the second argument is written with its message and stack', () => {
    const { log, lines } = capture();
    log.error('Could not save:', new Error('disk is full'));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /error: Could not save:/);
    assert.match(lines[0], /Error: disk is full/);
    assert.match(lines[0], /at /, 'the stack is there');
    assert.equal((lines[0].match(/disk is full/g) || []).length, 1, 'the message is not written twice');
});

test('an AggregateError with an empty message (a refused connection to localhost) still shows its cause', () => {
    const { log, lines } = capture();
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), { code: 'ECONNREFUSED' });
    const err = new AggregateError([refused], '');
    log.error('Redis connection error:', err);
    assert.match(lines[0], /ECONNREFUSED/);
    assert.match(lines[0], /127\.0\.0\.1:6379/);
});

test('an object passed as the second argument is written as JSON after the message', () => {
    const { log, lines } = capture();
    log.warn('System health issues detected:', { issues: ['3 job failures in the last hour'], time: 'now' });
    assert.match(lines[0], /System health issues detected: \{"issues":\["3 job failures in the last hour"\],"time":"now"\}/);
});

test('a string second argument is appended, and printf style placeholders work', () => {
    const { log, lines } = capture();
    log.error('Alert job 7 failed:', 'SMTP timeout');
    log.error('Failed to subscribe: %s', 'no route');
    assert.match(lines[0], /Alert job 7 failed: SMTP timeout$/);
    assert.match(lines[1], /Failed to subscribe: no route$/);
});

test('an entry with no extra arguments is just the message', () => {
    const { log, lines } = capture();
    log.info('plain');
    assert.match(lines[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} info: plain$/);
});

test('lines carry no ANSI colour codes', () => {
    const { log, lines } = capture();
    log.error('red?', new Error('x'));
    log.info('green?', { a: 1 });
    for (const line of lines) assert.doesNotMatch(line, /\x1b\[/);
});

test('webhook addresses and other secrets in metadata are hidden', () => {
    const { log, lines } = capture();
    log.info('Monitoring updates processed', {
        receivedMonitoring: { alerts: { webhookUrl: 'https://hooks.example.com/services/T000/B000/SECRET', enabled: true } },
        token: 'abc',
        password: 'hunter2',
    });
    assert.doesNotMatch(lines[0], /SECRET|hooks\.example\.com|abc|hunter2/);
    assert.match(lines[0], /"enabled":true/);
});

test('credentials inside an address are masked, in the message and in metadata', () => {
    const { log, lines } = capture();
    log.error('Bad target postgres://app:hunter2@db.example.com:5432/prod', { requestBody: { url: 'mysql://root:pw@10.0.0.5' } });
    assert.doesNotMatch(lines[0], /hunter2|:pw@/);
    assert.match(lines[0], /postgres:\/\/\*\*\*@db\.example\.com:5432\/prod/);
});

test('redact survives cycles and keeps ordinary values', () => {
    const loop = { name: 'a' };
    loop.self = loop;
    assert.deepEqual(redact(loop), { name: 'a', self: '[Circular]' });
    assert.deepEqual(redact({ n: 1, ok: true, list: [1, 'two'] }), { n: 1, ok: true, list: [1, 'two'] });
});

test('long metadata is cut', () => {
    const { log, lines } = capture();
    log.info('big', { blob: 'x'.repeat(5000) });
    assert.ok(lines[0].length < 2300);
    assert.match(lines[0], /\(cut\)$/);
});

test('the logger used by the app is silent under the test runner and does not touch the log files', () => {
    const logs = path.join(path.dirname(fileURLToPath(import.meta.url)), '../logs/combined.log');
    const before = fs.existsSync(logs) ? fs.statSync(logs).size : 0;
    logger.error('this must not reach the file', new Error('from a test'));
    logger.info('nor this');
    const after = fs.existsSync(logs) ? fs.statSync(logs).size : 0;
    assert.equal(logger.silent, true);
    assert.equal(after, before);
});

test('throttled runs once per interval and reports how many calls it held back', () => {
    const seen = [];
    const run = (now) => throttled('test-key', 1000, (n) => seen.push(n), now);
    assert.equal(run(10_000), true);
    assert.equal(run(10_100), false);
    assert.equal(run(10_900), false);
    assert.equal(run(11_000), true);
    assert.deepEqual(seen, [0, 2]);
    assert.equal(suppressedNote(2, 30_000), ' (2 more in the last 30s)');
    assert.equal(suppressedNote(0, 30_000), '');
});
