// Run with: npm test
// What the server said when a check failed: kept short, kept safe, and only for a failure.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import {
    MAX_SNIPPET_BYTES, safeHeaders, isTextual, snippetOf, readSnippet, buildEvidence, cleanEvidence
} from '../utils/evidence.js';
import { checkServerStatus } from '../services/monitoringService.js';

// ── headers ──

test('only headers that say who answered are kept, lower-cased, and cookies and credentials never are', () => {
    const kept = safeHeaders({
        Server: 'cloudflare', 'CF-Ray': '8a1b2c-LHR', 'Set-Cookie': 'session=secret', Authorization: 'Bearer x',
        'X-Api-Key': 'k', 'Content-Type': 'text/html; charset=utf-8', 'X-Custom': 'nope'
    });
    assert.deepEqual(kept, { server: 'cloudflare', 'cf-ray': '8a1b2c-LHR', 'content-type': 'text/html; charset=utf-8' });
});

test('a long value is cut, a list is joined, control characters go, and a redirect keeps its path but not its query', () => {
    const long = safeHeaders({ server: 'x'.repeat(500) });
    assert.equal(long.server.length, 201);
    assert.ok(long.server.endsWith('…'));
    assert.equal(safeHeaders({ via: ['1.1 a', '1.1 b'] }).via, '1.1 a, 1.1 b');
    assert.equal(safeHeaders({ server: 'ng\u0000inx\r\nX: y' }).server, 'nginx X: y');
    assert.equal(safeHeaders({ location: 'https://x.test/login?token=abc#frag' }).location, 'https://x.test/login');
});

test('anything that is not a header object gives nothing, and an AxiosHeaders-like object is read through toJSON', () => {
    for (const odd of [null, undefined, 'x', 5, []]) assert.deepEqual(safeHeaders(odd), {}, String(odd));
    assert.deepEqual(safeHeaders({ toJSON: () => ({ Server: 'nginx' }) }), { server: 'nginx' });
});

// ── the page ──

test('text, JSON and XML are quoted; images, archives and PDFs are not', () => {
    for (const ok of [undefined, '', 'text/html; charset=utf-8', 'application/json', 'application/problem+json', 'application/xml', 'image/svg+xml']) assert.equal(isTextual(ok), true, String(ok));
    for (const no of ['image/png', 'application/pdf', 'application/zip', 'application/octet-stream', 'video/mp4']) assert.equal(isTextual(no), false, no);
});

test('a page is cut at 1 KB, control characters are dropped, and a cut is marked', () => {
    const small = snippetOf('<h1>Down for maintenance</h1>', { contentType: 'text/html' });
    assert.deepEqual(small, { text: '<h1>Down for maintenance</h1>', truncated: false });

    const big = snippetOf('a'.repeat(5000), { contentType: 'text/plain' });
    assert.equal(big.text.length, MAX_SNIPPET_BYTES);
    assert.equal(big.truncated, true);

    assert.equal(snippetOf('ok\u0007\u001b[31m red', { contentType: 'text/plain' }).text, 'ok[31m red');
    assert.equal(snippetOf('a\r\n\r\n\r\n\r\nb', { contentType: 'text/plain' }).text, 'a\n\nb');
});

test('a character cut in half by the limit does not leave a broken mark behind', () => {
    const body = Buffer.from('é'.repeat(600), 'utf8'); // 1200 bytes, every character is two
    const { text } = snippetOf(body, { contentType: 'text/plain' });
    assert.ok(!text.includes('�'));
    assert.equal(text, 'é'.repeat(512));
});

test('no page, an empty page, binary under a text label, and a binary type give nothing', () => {
    assert.equal(snippetOf(null, {}), null);
    assert.equal(snippetOf(Buffer.alloc(0), { contentType: 'text/html' }), null);
    assert.equal(snippetOf(Buffer.from([0x89, 0x50, 0x00, 0x47]), { contentType: 'text/html' }), null);
    assert.equal(snippetOf('GIF89a', { contentType: 'image/gif' }), null);
});

// ── reading it ──

test('readSnippet reads the start of a stream, stops at the limit, and destroys the rest', async () => {
    const stream = Readable.from([Buffer.alloc(700, 'a'), Buffer.alloc(700, 'b'), Buffer.alloc(700, 'c')]);
    const { bytes, wasCut } = await readSnippet(stream);
    assert.equal(bytes.length, MAX_SNIPPET_BYTES);
    assert.equal(wasCut, true);
    assert.equal(stream.destroyed, true);
});

test('a short page is read whole, and a stalled or broken one gives what arrived', async () => {
    const whole = await readSnippet(Readable.from([Buffer.from('hello')]));
    assert.equal(whole.bytes.toString(), 'hello');
    assert.equal(whole.wasCut, false);

    const stalled = new Readable({ read() {} });
    stalled.push('partial');
    const waited = await readSnippet(stalled, { timeoutMs: 50 });
    assert.equal(waited.bytes.toString(), 'partial');
    assert.equal(stalled.destroyed, true);

    const broken = new Readable({ read() {} });
    broken.push('before the reset');
    setTimeout(() => broken.destroy(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), 10);
    assert.equal((await readSnippet(broken, { timeoutMs: 500 })).bytes.toString(), 'before the reset');
});

// ── the whole thing ──

test('evidence holds only the parts that exist, and is null when there are none', () => {
    assert.equal(buildEvidence({}), null);
    assert.equal(buildEvidence(), null);
    assert.deepEqual(buildEvidence({ address: '93.184.216.34' }), { address: '93.184.216.34' });
    assert.deepEqual(buildEvidence({ statusCode: 502, headers: { server: 'nginx' }, body: 'Bad Gateway' }), {
        statusCode: 502, headers: { server: 'nginx' }, snippet: 'Bad Gateway'
    });
    assert.equal(buildEvidence({ statusCode: 99 }), null, 'not a status');
    assert.equal(buildEvidence({ address: '<script>' }), null, 'not an address');
});

test('evidence read back from storage gets the same limits again', () => {
    const stored = cleanEvidence({
        statusCode: 503, headers: { server: 'x'.repeat(400), 'set-cookie': 'a=b' }, address: '10.0.0.1',
        snippet: `<p>${'z'.repeat(3000)}</p>`, extra: 'ignored'
    });
    assert.equal(stored.statusCode, 503);
    assert.deepEqual(Object.keys(stored.headers), ['server']);
    assert.equal(stored.snippet.length, MAX_SNIPPET_BYTES);
    assert.equal(stored.snippetTruncated, true);
    assert.equal('extra' in stored, false);
    for (const odd of [null, undefined, 'x', 5, {}, { statusCode: 'x', snippet: 5 }]) assert.equal(cleanEvidence(odd), null, String(odd));
});

// ── real checks ──

let server;
let port;
before(async () => {
    process.env.ALLOW_PRIVATE_TARGETS = 'true';
    server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/bad-gateway') {
            res.writeHead(502, { 'Content-Type': 'text/html', Server: 'nginx/1.24', 'Set-Cookie': 'sid=secret', 'CF-Ray': 'abc-LHR' });
            res.end('<html><body><h1>502 Bad Gateway</h1>' + 'x'.repeat(4000) + '</body></html>');
        } else if (url.pathname === '/binary') {
            res.writeHead(503, { 'Content-Type': 'application/octet-stream' });
            res.end(Buffer.from([0, 1, 2, 3]));
        } else if (url.pathname === '/maintenance') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Back soon</h1><p>We are doing maintenance.</p>');
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Welcome</h1>');
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
});
after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
});

const site = (path, monitoring = {}) => ({ url: `http://127.0.0.1:${port}${path}`, type: 'website', monitoring });

test('a failed check keeps what the server said: status, safe headers and the start of the page', async () => {
    const result = await checkServerStatus(site('/bad-gateway'));
    assert.equal(result.status, 'down');
    const e = result.evidence;
    assert.equal(e.statusCode, 502);
    assert.deepEqual(e.headers, { 'content-type': 'text/html', server: 'nginx/1.24', 'cf-ray': 'abc-LHR' });
    assert.ok(e.snippet.startsWith('<html><body><h1>502 Bad Gateway</h1>'));
    assert.equal(e.snippet.length, MAX_SNIPPET_BYTES);
    assert.equal(e.snippetTruncated, true);
    assert.ok(!JSON.stringify(e).includes('secret'), 'the cookie is never kept');
});

test('a binary page is not quoted, but the status is still kept', async () => {
    const result = await checkServerStatus(site('/binary'));
    assert.equal(result.evidence.statusCode, 503);
    assert.equal('snippet' in result.evidence, false);
});

test('a page that fails the keyword check keeps its start, so the wrong page can be seen', async () => {
    const result = await checkServerStatus(site('/maintenance', { keyword: { text: 'Welcome', mode: 'present' } }));
    assert.equal(result.failure.kind, 'content');
    assert.equal(result.evidence.statusCode, 200);
    assert.ok(result.evidence.snippet.includes('We are doing maintenance.'));
});

test('a check that works keeps no evidence, and never reads the page', async () => {
    const result = await checkServerStatus(site('/'));
    assert.equal(result.status, 'up');
    assert.equal(result.evidence, null);
});

test('a failure with no answer and no resolved name has no evidence', async () => {
    // nothing listens on port 1; the address is typed, so nothing was resolved
    const result = await checkServerStatus({ url: 'http://127.0.0.1:1/', type: 'website', monitoring: {} });
    assert.equal(result.status, 'down');
    assert.equal(result.evidence, null);
});
