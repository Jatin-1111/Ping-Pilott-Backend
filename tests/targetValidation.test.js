// Run with: npm test
// A monitored address has to be an address of the right kind. `file:///etc/passwd` was saved as a website monitor, a TCP monitor
// could have port 0 or 65536, a tab was kept inside a URL, and a number became a string before the schema saw it. No database.

import test from 'node:test';
import assert from 'node:assert/strict';
import { targetProblem } from '../utils/address.js';
import { createServerSchema, updateServerSchema } from '../utils/validations.js';

test('websites and APIs accept http, https and a bare host, with a port or path', () => {
    for (const ok of ['example.com', 'https://example.com', 'http://example.com', 'example.com:8080/health', 'https://sub.example.com/a?b=1', 'HTTP://Example.com', '[2001:db8::1]:8080']) {
        assert.equal(targetProblem('website', ok), null, ok);
        assert.equal(targetProblem('api', ok), null, ok);
    }
});

test('websites and APIs refuse every other kind of address', () => {
    for (const bad of ['file:///etc/passwd', 'gopher://example.com', 'ftp://example.com', 'javascript://x', 'redis://example.com:6379', 'data://x']) {
        assert.match(targetProblem('website', bad), /http or https/, bad);
    }
});

test('an address with spaces or control characters is refused, for every type', () => {
    for (const type of ['website', 'api', 'tcp', 'database']) {
        assert.match(targetProblem(type, 'example.com/a b'), /spaces or control/);
        assert.match(targetProblem(type, 'example.com/a\tb'), /spaces or control/);
        assert.match(targetProblem(type, 'exa\u0000mple.com'), /spaces or control/);
    }
});

test('a website address with no host is refused', () => {
    assert.ok(targetProblem('website', 'https://'));
    assert.ok(targetProblem('website', 'example.com:99999'));
});

test('TCP and database addresses need a real port from 1 to 65535', () => {
    for (const ok of ['example.com:5432', 'db.example.com:1', 'db.example.com:65535', 'postgres://db.example.com', 'postgres://db.example.com:5432/app', '[2001:db8::1]:443', 'example.com']) {
        assert.equal(targetProblem('tcp', ok), null, ok);
        assert.equal(targetProblem('database', ok), null, ok);
    }
    for (const bad of ['example.com:0', 'example.com:65536', 'example.com:99999', 'example.com:', 'postgres://db.example.com:70000']) {
        assert.match(targetProblem('tcp', bad), /port/i, bad);
    }
});

test('TCP and database accept connection-style schemes (their default port is used)', () => {
    assert.equal(targetProblem('database', 'mongodb://db.example.com'), null);
    assert.equal(targetProblem('database', 'mysql://db.example.com:3306'), null);
});

test('an empty or hostless TCP address is refused', () => {
    assert.ok(targetProblem('tcp', ''));
    assert.ok(targetProblem('tcp', ':5432'));
});

// ---- the schemas ----------------------------------------------------------------------------------------------

const create = (body) => createServerSchema.safeParse({ name: 'Site', ...body });
const issue = (result) => result.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ');

test('creating a website monitor from a file: address is refused with a message about the address', () => {
    const result = create({ url: 'file:///etc/passwd' });
    assert.equal(result.success, false);
    assert.match(issue(result), /url: .*http or https/);
});

test('creating a TCP monitor with an impossible port is refused', () => {
    assert.equal(create({ url: 'example.com:65536', type: 'tcp' }).success, false);
    assert.equal(create({ url: 'example.com:0', type: 'tcp' }).success, false);
    assert.equal(create({ url: 'example.com:22', type: 'tcp' }).success, true);
});

test('the type defaults to website, so the website rules apply when it is left out', () => {
    assert.equal(create({ url: 'file:///etc/passwd' }).success, false);
    assert.equal(create({ url: 'https://example.com' }).success, true);
});

test('name and address are trimmed, and a blank name is refused', () => {
    const ok = create({ name: '  Shop  ', url: '  https://example.com  ' });
    assert.equal(ok.success, true);
    assert.equal(ok.data.name, 'Shop');
    assert.equal(ok.data.url, 'https://example.com');
    assert.equal(create({ name: '   ', url: 'https://example.com' }).success, false);
});

test('a number or object where text belongs is refused, not turned into text', () => {
    assert.equal(create({ url: 123 }).success, false);
    assert.equal(createServerSchema.safeParse({ name: { a: 1 }, url: 'https://example.com' }).success, false);
});

test('an update that sends a type with the address is checked at once; one without waits for the controller', () => {
    assert.equal(updateServerSchema.safeParse({ url: 'file:///etc/passwd', type: 'website' }).success, false);
    // no type here: the schema cannot know, the controller checks it against the stored type
    assert.equal(updateServerSchema.safeParse({ url: 'file:///etc/passwd' }).success, true);
    assert.equal(updateServerSchema.safeParse({ name: 'Renamed' }).success, true);
});

test('the response threshold is at least 100 ms, as the route used to require', () => {
    assert.equal(create({ url: 'https://example.com', monitoring: { alerts: { responseThreshold: 50 } } }).success, false);
    assert.equal(create({ url: 'https://example.com', monitoring: { alerts: { responseThreshold: 100 } } }).success, true);
});

test('formatted phone numbers are accepted (they are reduced to digits when saved)', () => {
    assert.equal(create({ url: 'https://example.com', contactPhones: ['+91 98765 43210'] }).success, true);
    assert.equal(create({ url: 'https://example.com', contactPhones: ['123'] }).success, false);
});
