// Run with: npm test
// A check resolves its hostname once, not twice. Before, assertPublicHost looked the name up as a pre-flight and the
// connection looked it up again, both on libuv's 4-thread pool, so dead names could make healthy lookups wait and that
// wait was reported as response time. The private-address protection must not depend on the pre-flight lookup.

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { assertPublicHost, PrivateTargetError } from '../utils/ssrfGuard.js';
import { checkServerStatus } from '../services/monitoringService.js';
import { describeThreadPool, RECOMMENDED_THREADS } from '../utils/threadPool.js';

const realLookup = dns.lookup;
const realPromisesLookup = dns.promises.lookup;
let connectLookups; // dns.lookup: what the connection uses (safeLookup)
let preflightLookups; // dns.promises.lookup: what assertPublicHost uses
let answer; // what the patched lookups say

const notFound = () => Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });

beforeEach(() => {
    delete process.env.ALLOW_PRIVATE_TARGETS; // the guard is what is under test
    connectLookups = [];
    preflightLookups = [];
    answer = () => { throw notFound(); };

    dns.lookup = (hostname, options, callback) => {
        connectLookups.push(hostname);
        try {
            const addresses = answer(hostname);
            callback(null, addresses);
        } catch (err) {
            callback(err);
        }
    };
    dns.promises.lookup = async (hostname) => {
        preflightLookups.push(hostname);
        return answer(hostname);
    };
});

afterEach(() => {
    dns.lookup = realLookup;
    dns.promises.lookup = realPromisesLookup;
});

const http = (url) => ({ url, type: 'website', monitoring: {} });

test('an HTTP check looks the name up once, on the connection, with no pre-flight lookup', async () => {
    const result = await checkServerStatus(http('missing-host.test'));
    assert.equal(result.status, 'down');
    assert.equal(result.error, 'DNS lookup failed (host not found)');
    assert.deepEqual(preflightLookups, [], 'no pre-flight lookup');
    assert.deepEqual(connectLookups, ['missing-host.test'], 'one lookup, made by the connection');
});

test('a TCP check looks the name up once as well', async () => {
    const result = await checkServerStatus({ url: 'db-missing.test:5432', type: 'tcp', monitoring: {} });
    assert.equal(result.status, 'down');
    assert.deepEqual(preflightLookups, []);
    assert.deepEqual(connectLookups, ['db-missing.test']);
});

test('a name that resolves to a private address is still refused, by the connection', async () => {
    answer = () => [{ address: '127.0.0.1', family: 4 }];
    const result = await checkServerStatus(http('sneaky.test'));
    assert.equal(result.status, 'down');
    assert.match(result.error, /private or internal address/);
    assert.deepEqual(preflightLookups, [], 'it did not need the pre-flight to be caught');

    const tcp = await checkServerStatus({ url: 'sneaky.test:6379', type: 'tcp', monitoring: {} });
    assert.equal(tcp.status, 'down');
    assert.match(tcp.error, /private or internal address/);
});

test('private addresses written out, and names that are private by their shape, are refused with no lookup at all', async () => {
    for (const url of ['http://127.0.0.1/', 'http://10.0.0.5/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data']) {
        const result = await checkServerStatus(http(url));
        assert.equal(result.status, 'down', url);
        assert.match(result.error, /private or internal address/, url);
    }
    for (const url of ['http://localhost/', 'http://printer.local/', 'http://db.internal/', 'http://app.localhost/']) {
        const result = await checkServerStatus(http(url));
        assert.equal(result.status, 'down', url);
        assert.match(result.error, /private or internal address/, url);
    }
    assert.deepEqual(preflightLookups, []);
    assert.deepEqual(connectLookups, [], 'nothing was even looked up');
});

test('saving an address still resolves it, so the user hears about a private name straight away', async () => {
    answer = () => [{ address: '10.1.2.3', family: 4 }];
    await assert.rejects(assertPublicHost('internal-app.example.com'), PrivateTargetError);
    assert.deepEqual(preflightLookups, ['internal-app.example.com']);

    answer = () => [{ address: '93.184.216.34', family: 4 }];
    await assertPublicHost('example.com'); // public: fine
    answer = () => { throw notFound(); };
    await assertPublicHost('does-not-exist.example'); // unresolved: left to the real check, as before
});

test('assertPublicHost with resolve: false never calls the lookup it is given', async () => {
    let calls = 0;
    const lookup = async () => { calls += 1; return [{ address: '10.0.0.1', family: 4 }]; };

    await assertPublicHost('looks-public.example.com', { resolve: false, lookup }); // would be private if resolved
    assert.equal(calls, 0);

    await assert.rejects(assertPublicHost('looks-public.example.com', { lookup }), PrivateTargetError);
    assert.equal(calls, 1);

    // what needs no lookup is still enforced
    await assert.rejects(assertPublicHost('192.168.1.1', { resolve: false, lookup }), PrivateTargetError);
    await assert.rejects(assertPublicHost('localhost', { resolve: false, lookup }), PrivateTargetError);
    assert.equal(calls, 1);
});

test('the thread pool check: unset or small is a warning, 16 or more is fine, junk counts as unset', () => {
    const unset = describeThreadPool({});
    assert.equal(unset.ok, false);
    assert.equal(unset.size, 4);
    assert.match(unset.message, /UV_THREADPOOL_SIZE is not set/);
    assert.match(unset.message, /not only in \.env/);

    for (const junk of ['', 'lots', '0', '-3']) assert.equal(describeThreadPool({ UV_THREADPOOL_SIZE: junk }).ok, false, `"${junk}"`);

    const small = describeThreadPool({ UV_THREADPOOL_SIZE: '8' });
    assert.equal(small.ok, false);
    assert.equal(small.size, 8);
    assert.match(small.message, /is 8; 16 is recommended/);

    for (const size of ['16', '32', '128']) {
        const fine = describeThreadPool({ UV_THREADPOOL_SIZE: size });
        assert.equal(fine.ok, true, size);
        assert.equal(fine.size, Number(size));
    }
    assert.equal(RECOMMENDED_THREADS, 16);
});
