// Run with: npm test
// A keyword check reads the page and looks for text (or for its absence): a site can answer 200 and still be broken.
// The page is somebody else's server, so it is read within limits: at most 512 KB after decompression, and only for as
// long as the check has left. The time reported is still the time to the response headers.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { cleanKeyword, describeKeywordFailure, findInBody, MAX_BODY_BYTES, MAX_KEYWORD_LENGTH } from '../utils/keyword.js';
import { ContentError, classifyFailure, FAILURE_KINDS } from '../utils/failures.js';
import { createServerSchema, updateServerSchema } from '../utils/validations.js';
import { buildMonitoringConfig, buildMonitoringUpdates } from '../utils/monitoringSettings.js';
import { checkServerStatus, checkHttpServer } from '../services/monitoringService.js';
import Server from '../models/Server.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const streamOf = (...chunks) => Readable.from(chunks.map((c) => Buffer.from(c)));

// ── the keyword ──

test('a keyword is trimmed text and a mode; anything unusable is no keyword', () => {
    assert.deepEqual(cleanKeyword({ text: '  Add to cart ' }), { text: 'Add to cart', mode: 'present' });
    assert.deepEqual(cleanKeyword({ text: 'Maintenance', mode: 'absent' }), { text: 'Maintenance', mode: 'absent' });
    assert.deepEqual(cleanKeyword({ text: 'x', mode: 'weird' }), { text: 'x', mode: 'present' }, 'an unknown mode is the default');
    for (const none of [null, undefined, 'text', 5, {}, { text: '' }, { text: '   ' }, { text: 7 }, { text: 'x'.repeat(MAX_KEYWORD_LENGTH + 1) }]) {
        assert.equal(cleanKeyword(none), null, JSON.stringify(none)?.slice(0, 30));
    }
    assert.equal(cleanKeyword({ text: 'x'.repeat(MAX_KEYWORD_LENGTH) }).text.length, MAX_KEYWORD_LENGTH);
});

test('the sentence names the text, cuts a long one, and says which way it failed', () => {
    assert.equal(describeKeywordFailure({ text: 'Add to cart', mode: 'present' }), 'The page does not contain "Add to cart".');
    assert.equal(describeKeywordFailure({ text: 'Maintenance', mode: 'absent' }), 'The page contains "Maintenance", which it should not.');
    assert.match(describeKeywordFailure({ text: 'y'.repeat(90), mode: 'present' }), /^The page does not contain "y{40}…"\.$/);
});

test('content is a failure kind, with the status the server answered', () => {
    assert.ok(FAILURE_KINDS.includes('content'));
    assert.deepEqual(classifyFailure(new ContentError('The page does not contain "x".', 200)), {
        kind: 'content', message: 'The page does not contain "x".', statusCode: 200
    });
});

// ── reading the page ──

test('it finds the text however the case differs, and stops reading once it has', async () => {
    const result = await findInBody(streamOf('<h1>Welcome to the SHOP</h1>', 'never read'), 'shop', { timeoutMs: 1000 });
    assert.equal(result.found, true);
    assert.ok(result.bytes < 40, `stopped after the first chunk, read ${result.bytes}`);
});

test('text split between two chunks is still found', async () => {
    assert.equal((await findInBody(streamOf('...add to c', 'art...'), 'add to cart', { timeoutMs: 1000 })).found, true);
    assert.equal((await findInBody(streamOf('a', 'b', 'c', 'd'), 'abcd', { timeoutMs: 1000 })).found, true, 'even a byte at a time');
    assert.equal((await findInBody(streamOf('abc', 'x'), 'abcd', { timeoutMs: 1000 })).found, false);
});

test('a character split across two chunks is read as one', async () => {
    const bytes = Buffer.from('prix: café');
    const cut = bytes.length - 1; // the é is two bytes: the cut falls inside it
    const stream = Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]);
    assert.equal((await findInBody(stream, 'café', { timeoutMs: 1000 })).found, true);
});

test('a page without the text is read to its end and reports not found', async () => {
    const result = await findInBody(streamOf('one', 'two', 'three'), 'four', { timeoutMs: 1000 });
    assert.deepEqual(result, { found: false, bytes: 11, capped: false });
});

test('reading stops at the size limit, and says it did', async () => {
    const endless = new Readable({ read() { this.push(Buffer.alloc(64 * 1024, 'a')); } });
    const result = await findInBody(endless, 'needle', { maxBytes: 200 * 1024, timeoutMs: 2000 });
    assert.equal(result.found, false);
    assert.equal(result.capped, true);
    assert.ok(result.bytes >= 200 * 1024 && result.bytes < 400 * 1024, `read ${result.bytes}`);
    assert.equal(endless.destroyed, true, 'and the stream is let go');
    assert.equal(MAX_BODY_BYTES, 512 * 1024);
});

test('a page that drips forever gives up at the deadline instead of holding the check', async () => {
    const dripping = new Readable({ read() { setTimeout(() => this.push('.'), 50); } });
    const started = Date.now();
    await assert.rejects(findInBody(dripping, 'never', { timeoutMs: 250 }), (err) => err.code === 'ETIMEDOUT');
    assert.ok(Date.now() - started < 1000, 'it did not wait for the page to end');
    assert.equal(dripping.destroyed, true);
});

test('a connection that breaks mid-page is that error, not a missing keyword', async () => {
    const broken = new Readable({ read() { this.push('half a pa'); this.destroy(Object.assign(new Error('reset'), { code: 'ECONNRESET' })); } });
    await assert.rejects(findInBody(broken, 'page', { timeoutMs: 1000 }), (err) => err.code === 'ECONNRESET');
});

// ── the setting, as it is sent and stored ──

const base = { name: 'Shop', url: 'shop.example.com' };

test('validation accepts a keyword, defaults nothing, lets null take it away, and refuses a bad one', () => {
    for (const schema of [createServerSchema, updateServerSchema]) {
        const ok = schema.safeParse({ ...base, monitoring: { keyword: { text: ' Add to cart ', mode: 'absent' } } });
        assert.equal(ok.success, true);
        assert.deepEqual(ok.data.monitoring.keyword, { text: 'Add to cart', mode: 'absent' }, 'trimmed');

        assert.equal(schema.safeParse({ ...base, monitoring: { keyword: { text: 'x' } } }).success, true, 'mode is optional');
        assert.equal(schema.safeParse({ ...base, monitoring: { keyword: null } }).success, true, 'null takes it away');
        assert.equal(schema.safeParse({ ...base, monitoring: {} }).success, true, 'and it is optional');

        for (const bad of [{ text: '' }, { text: '   ' }, { text: 'x'.repeat(101) }, { text: 'x', mode: 'maybe' }, {}, 'text', 5]) {
            const result = schema.safeParse({ ...base, monitoring: { keyword: bad } });
            assert.equal(result.success, false, JSON.stringify(bad)?.slice(0, 30));
            assert.match(result.error.issues[0].path.join('.'), /^monitoring\.keyword/);
        }
    }
});

test('a keyword is refused with a TCP or database type in the same request, and allowed for websites and APIs', () => {
    for (const type of ['tcp', 'database']) {
        for (const schema of [createServerSchema, updateServerSchema]) {
            const result = schema.safeParse({ ...base, type, monitoring: { keyword: { text: 'x' } } });
            assert.equal(result.success, false, `${type}`);
            assert.equal(result.error.issues[0].path.join('.'), 'monitoring.keyword');
            assert.match(result.error.issues[0].message, /websites and APIs/);
        }
        assert.equal(createServerSchema.safeParse({ ...base, type, monitoring: {} }).success, true, 'no keyword is fine');
    }
    for (const type of ['website', 'api']) assert.equal(createServerSchema.safeParse({ ...base, type, monitoring: { keyword: { text: 'x' } } }).success, true, type);
});

test('the server model takes a keyword and refuses an empty or oversized one', () => {
    const owner = '5f1d7f3a8f3c2a1b4c8e9d10';
    const make = (keyword) => new Server({ name: 'a', url: 'a.com', uploadedBy: owner, monitoring: { keyword } });
    assert.equal(make({ text: 'Add to cart' }).validateSync(), undefined);
    assert.equal(make({ text: 'Add to cart' }).monitoring.keyword.mode, 'present', 'the default mode');
    assert.ok(make({ text: '' }).validateSync()?.errors?.['monitoring.keyword.text']);
    assert.ok(make({ text: 'x'.repeat(101) }).validateSync()?.errors?.['monitoring.keyword.text']);
    assert.ok(make({ text: 'x', mode: 'maybe' }).validateSync()?.errors?.['monitoring.keyword.mode']);
    assert.equal(new Server({ name: 'a', url: 'a.com', uploadedBy: owner }).monitoring.keyword, undefined, 'none by default');
});

test('creating stores the keyword, and updating sets, removes or leaves it, from the validated settings only', () => {
    assert.deepEqual(buildMonitoringConfig({ keyword: { text: ' Shop ', mode: 'absent' } }, 'user', null).keyword, { text: 'Shop', mode: 'absent' });
    assert.equal('keyword' in buildMonitoringConfig({}, 'user', null), false);
    assert.equal('keyword' in buildMonitoringConfig({ keyword: { text: '' } }, 'user', null), false);

    assert.deepEqual(buildMonitoringUpdates({}, { keyword: { text: 'Shop', mode: 'present' } })['monitoring.keyword'], { text: 'Shop', mode: 'present' });
    assert.equal(buildMonitoringUpdates({}, { keyword: null })['monitoring.keyword'], null, 'null removes it');
    assert.equal('monitoring.keyword' in buildMonitoringUpdates({ frequency: 5 }, { frequency: 5 }), false, 'not sent: not touched');
    assert.equal('monitoring.keyword' in buildMonitoringUpdates({ keyword: { text: 'evil' } }, {}), false, 'a value that did not pass validation is ignored');
});

// ── real checks ──

let server;
let port;
const requests = [];

const PAGES = {
    '/shop': '<html><body><h1>Welcome to the Shop</h1><button>Add to cart</button></body></html>',
    '/maintenance': '<html><body><h1>We are down for Maintenance</h1></body></html>',
    '/error-page': '<html><body>Something went wrong. Error 500.</body></html>'
};

before(async () => {
    process.env.ALLOW_PRIVATE_TARGETS = 'true';
    server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        requests.push({ method: req.method, path: url.pathname });

        if (url.pathname === '/redir') {
            res.writeHead(302, { Location: '/shop', 'Content-Length': 0 }).end();
        } else if (url.pathname === '/gzip') {
            // the keyword is at the end of a body that is large before compression and small after
            const body = zlib.gzipSync(Buffer.from(`${'x'.repeat(100 * 1024)} the end: Add to cart`));
            res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': body.length }).end(req.method === 'HEAD' ? undefined : body);
        } else if (url.pathname === '/huge') {
            // a page far larger than the limit, with the text only at the very end; the server stops when the client lets go
            res.writeHead(200, { 'Content-Type': 'text/html' });
            let sent = 0;
            const push = () => {
                while (!res.destroyed && sent < 8 * 1024 * 1024) {
                    sent += 64 * 1024;
                    if (!res.write(Buffer.alloc(64 * 1024, 'a'))) return res.once('drain', push);
                }
                if (!res.destroyed) res.end('Add to cart');
            };
            push();
        } else if (url.pathname === '/status') {
            res.writeHead(Number(url.searchParams.get('status') || 200), { 'Content-Length': 24 });
            res.end(req.method === 'HEAD' ? undefined : 'Add to cart is on page');
        } else {
            const body = PAGES[url.pathname] ?? 'ok';
            res.writeHead(200, { 'Content-Length': Buffer.byteLength(body) });
            res.end(req.method === 'HEAD' ? undefined : body);
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
});

after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
});

const monitor = (path, keyword, extra = {}) => ({
    url: `http://127.0.0.1:${port}${path}`,
    type: 'website',
    monitoring: { keyword, ...extra }
});

test('a page with the text is up, and a page without it is down with a content failure', async () => {
    const found = await checkServerStatus(monitor('/shop', { text: 'add to CART', mode: 'present' }));
    assert.equal(found.status, 'up');
    assert.equal(found.statusCode, 200);
    assert.equal(found.failure, null);

    const missing = await checkServerStatus(monitor('/shop', { text: 'Checkout', mode: 'present' }));
    assert.equal(missing.status, 'down');
    assert.equal(missing.error, 'The page does not contain "Checkout".');
    assert.deepEqual(missing.failure, { kind: 'content', statusCode: 200 });
    assert.equal(missing.responseTime, null);
});

test('with "absent", finding the text is the failure', async () => {
    const bad = await checkServerStatus(monitor('/maintenance', { text: 'maintenance', mode: 'absent' }));
    assert.equal(bad.status, 'down');
    assert.equal(bad.error, 'The page contains "maintenance", which it should not.');
    assert.deepEqual(bad.failure, { kind: 'content', statusCode: 200 });

    assert.equal((await checkServerStatus(monitor('/shop', { text: 'maintenance', mode: 'absent' }))).status, 'up');
    assert.equal((await checkServerStatus(monitor('/error-page', { text: 'Error 500', mode: 'absent' }))).status, 'down');
});

test('a keyword check asks for the page with GET; without one the check still uses HEAD', async () => {
    requests.length = 0;
    await checkServerStatus(monitor('/shop', { text: 'Shop', mode: 'present' }));
    assert.deepEqual(requests.map((r) => r.method), ['GET']);

    requests.length = 0;
    await checkServerStatus(monitor('/shop', undefined));
    assert.deepEqual(requests.map((r) => r.method), ['HEAD']);
});

test('the keyword is judged on the page the check ends up on, after a redirect', async () => {
    assert.equal((await checkServerStatus(monitor('/redir', { text: 'Add to cart', mode: 'present' }))).status, 'up');
    assert.equal((await checkServerStatus(monitor('/redir', { text: 'Not on that page', mode: 'present' }))).status, 'down');
});

test('a compressed page is read decompressed', async () => {
    const result = await checkServerStatus(monitor('/gzip', { text: 'the end: add to cart', mode: 'present' }));
    assert.equal(result.status, 'up');
});

test('a page far larger than the limit is not read past it, and the check does not wait for it', async () => {
    const started = Date.now();
    const result = await checkServerStatus(monitor('/huge', { text: 'Add to cart', mode: 'present' }));
    assert.equal(result.status, 'down', 'the text is beyond the first 512 KB, so it is not found');
    assert.deepEqual(result.failure, { kind: 'content', statusCode: 200 });
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms: it did not read 8 MB`);
});

test('the status must be an accepted one before the page is looked at', async () => {
    const result = await checkServerStatus(monitor('/status?status=503', { text: 'Add to cart', mode: 'present' }));
    assert.equal(result.status, 'down');
    assert.deepEqual(result.failure, { kind: 'http', statusCode: 503 }, 'an HTTP failure, not a missing keyword');

    // with 403 accepted, the page of a 403 is judged
    const accepted = await checkServerStatus(monitor('/status?status=403', { text: 'Add to cart', mode: 'present' }, { acceptedStatus: '200-399,403' }));
    assert.equal(accepted.status, 'up');
    assert.equal(accepted.statusCode, 403);
});

test('the time reported is still the time to the headers, with its phases', async () => {
    const result = await checkServerStatus(monitor('/shop', { text: 'Shop', mode: 'present' }));
    assert.equal(result.status, 'up');
    assert.ok(result.responseTime >= 1 && result.responseTime < 1000);
    assert.ok(result.timings && Number.isFinite(result.timings.ttfb));
    assert.equal(result.serverTime, Math.max(0, result.timings.ttfb - result.timings.connect));
});

test('a page that drips past the deadline is a timeout, not a missing keyword', async () => {
    const slow = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        const timer = setInterval(() => res.write('.'), 40);
        res.on('close', () => clearInterval(timer));
    });
    await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
    try {
        await assert.rejects(
            checkHttpServer(`http://127.0.0.1:${slow.address().port}/`, { keyword: { text: 'never', mode: 'present' }, bodyTimeoutMs: 300 }),
            (err) => err.code === 'ETIMEDOUT'
        );
    } finally {
        slow.closeAllConnections?.();
        await new Promise((resolve) => slow.close(resolve));
    }
});

test('a TCP or database monitor ignores a keyword that somehow is on it', async () => {
    const open = net.createServer((socket) => socket.end());
    await new Promise((resolve) => open.listen(0, '127.0.0.1', resolve));
    try {
        for (const type of ['tcp', 'database']) {
            const result = await checkServerStatus({ url: `127.0.0.1:${open.address().port}`, type, monitoring: { keyword: { text: 'x', mode: 'present' } } });
            assert.equal(result.status, 'up', type);
            assert.equal(result.failure, null);
        }
    } finally {
        await new Promise((resolve) => open.close(resolve));
    }
});
