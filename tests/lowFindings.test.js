// Run with: npm test
// The small things from the API audit: one error shape, no-store on API answers, a per-address limit on e-mails, an expired token not
// being a server error in the log, and what a new password has to be. No database.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { passwordProblem, passwordRule } from '../utils/passwordPolicy.js';
import { errorBody, validationBody, defaultCode } from '../utils/apiError.js';
import errorMiddleware, { ErrorResponse } from '../middleware/error.js';
import { noStore } from '../middleware/noStore.js';

// read when middleware/rateLimiter.js is first loaded
process.env.EMAIL_ADDRESS_LIMIT_PER_HOUR = '3';
process.env.JWT_SECRET = 'test-secret';

// ---- L8: passwords ----------------------------------------------------------------------------------------------

test('a new password needs at least 8 characters', () => {
    assert.match(passwordProblem('1234567'), /at least 8/);
    assert.match(passwordProblem('abc'), /at least 8/);
    assert.equal(passwordProblem('correct horse battery'), null);
});

test('the commonest passwords are refused, whatever the case', () => {
    for (const bad of ['password', 'Password1', 'PASSWORD123', '12345678', '123456789', 'qwertyuiop', 'iloveyou', 'Welcome123', 'pingpilott']) {
        assert.ok(passwordProblem(bad), bad);
    }
});

test('a common password with look-alike characters or a tail of digits and symbols is still refused', () => {
    for (const bad of ['P@ssw0rd', 'P@ssw0rd2026!', 'Password123!', 'Qwerty!!!!', 'letmein2026', 'Welcome-2026!', 'Admin@2026']) {
        assert.match(passwordProblem(bad), /too common/, bad);
    }
});

test('a password of one repeated character is refused', () => {
    assert.match(passwordProblem('aaaaaaaaaa'), /too simple/);
    assert.match(passwordProblem('9999999999'), /too simple/);
});

test('a password longer than bcrypt reads (72 bytes) is refused, counting bytes not characters', () => {
    assert.equal(passwordProblem('ab'.repeat(36)), null); // exactly 72 bytes
    assert.match(passwordProblem('ab'.repeat(36) + 'c'), /at most 72 bytes/);
    // 40 two-byte characters are 40 characters but 80 bytes
    assert.match(passwordProblem('é'.repeat(40)), /at most 72 bytes/);
});

test('ordinary strong passwords and passphrases are accepted', () => {
    for (const ok of ['Tr0ub4dor&3-horse', 'my dog is called Biscuit', 'N7#qLm2!vXr9', 'Welcome to the jungle, baby']) {
        assert.equal(passwordProblem(ok), null, ok);
    }
});

test('a value that is not text is refused, not crashed on', () => {
    for (const bad of [undefined, null, 12345678, ['password123'], { a: 1 }]) assert.ok(passwordProblem(bad));
});

test('passwordRule throws the reason for express-validator, and returns true when fine', () => {
    assert.equal(passwordRule('correct horse battery'), true);
    assert.throws(() => passwordRule('123'), /at least 8/);
});

// ---- L3: one error shape ----------------------------------------------------------------------------------------

function runError(err, { env = 'test' } = {}) {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = env;
    let sent = null;
    const res = { status(code) { this.code = code; return this; }, json(body) { sent = { status: this.code, body }; } };
    try { errorMiddleware(err, { originalUrl: '/x', method: 'GET' }, res, () => {}); } finally { process.env.NODE_ENV = previous; }
    return sent;
}

test('every error answer has status, message and code', () => {
    const cases = [
        new ErrorResponse('nope', 403),
        Object.assign(new Error('boom'), { name: 'JsonWebTokenError' }),
        Object.assign(new Error('x'), { name: 'ValidationError', errors: { a: { message: 'a is wrong' } } }),
        new Error('unexpected')
    ];
    for (const c of cases) {
        const { body } = runError(c);
        assert.equal(body.status, 'error');
        assert.equal(typeof body.message, 'string');
        assert.equal(typeof body.code, 'string', `no code for ${c.name}`);
    }
});

test('a bad id in the URL is 404 NOT_FOUND, a bad value anywhere else is 400 and does not echo the value', () => {
    const inUrl = runError(Object.assign(new Error('Cast to ObjectId failed'), { name: 'CastError', path: '_id', value: 'not-an-id' }));
    assert.deepEqual([inUrl.status, inUrl.body.code], [404, 'NOT_FOUND']);
    assert.ok(!inUrl.body.message.includes('not-an-id'));

    const elsewhere = runError(Object.assign(new Error('Cast to string failed'), { name: 'CastError', path: 'status', value: { a: 'secret-ish' } }));
    assert.deepEqual([elsewhere.status, elsewhere.body.code], [400, 'INVALID_VALUE']);
    assert.match(elsewhere.body.message, /status/);
    assert.ok(!JSON.stringify(elsewhere.body).includes('secret-ish'));
});

test('malformed JSON and oversized bodies get their own codes and no parser text', () => {
    const bad = runError(Object.assign(new SyntaxError('Unexpected end of JSON input'), { type: 'entity.parse.failed', status: 400 }));
    assert.deepEqual([bad.status, bad.body.code, bad.body.message], [400, 'INVALID_JSON', 'The request body is not valid JSON']);
    const big = runError(Object.assign(new Error('request entity too large'), { type: 'entity.too.large', status: 413 }));
    assert.deepEqual([big.status, big.body.code], [413, 'PAYLOAD_TOO_LARGE']);
});

test('token errors say which: invalid or expired', () => {
    assert.equal(runError(Object.assign(new Error('x'), { name: 'JsonWebTokenError' })).body.code, 'INVALID_TOKEN');
    assert.equal(runError(Object.assign(new Error('x'), { name: 'TokenExpiredError' })).body.code, 'TOKEN_EXPIRED');
});

test('a duplicate key is 400 DUPLICATE', () => {
    const r = runError(Object.assign(new Error('E11000'), { code: 11000, keyValue: { slug: 'taken' } }));
    assert.deepEqual([r.status, r.body.code], [400, 'DUPLICATE']);
});

test('a raw error code (ECONNRESET, ...) is never handed to the client', () => {
    const r = runError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), { env: 'production' });
    assert.equal(r.status, 500);
    assert.equal(r.body.code, 'SERVER_ERROR');
    assert.equal(r.body.message, 'Server Error');
});

test('defaultCode and the body helpers', () => {
    assert.equal(defaultCode(404), 'NOT_FOUND');
    assert.equal(defaultCode(429), 'RATE_LIMITED');
    assert.equal(defaultCode(503), 'SERVER_ERROR');
    assert.deepEqual(errorBody('m', 'C'), { status: 'error', message: 'm', code: 'C' });
    const v = validationBody([{ field: 'password', message: 'Use at least 8 characters.' }, { field: 'email', message: 'Bad email' }]);
    assert.equal(v.message, 'Use at least 8 characters.');
    assert.equal(v.code, 'VALIDATION_ERROR');
    assert.equal(v.errors.length, 2);
    assert.equal(validationBody([]).message, 'Validation error');
});

// ---- L4: no-store -----------------------------------------------------------------------------------------------

async function serve(configure) {
    const { default: express } = await import('express');
    const app = express();
    configure(app);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return { port, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('API answers are no-store, and a handler that asks for caching still gets it', async () => {
    const app = await serve((a) => {
        a.use('/api', noStore);
        a.get('/api/me', (req, res) => res.json({ ok: true }));
        a.get('/api/public', (req, res) => { res.set('Cache-Control', 'public, max-age=30'); res.json({ ok: true }); });
    });
    try {
        const me = await fetch(`http://127.0.0.1:${app.port}/api/me`);
        const pub = await fetch(`http://127.0.0.1:${app.port}/api/public`);
        assert.equal(me.headers.get('cache-control'), 'no-store');
        assert.equal(pub.headers.get('cache-control'), 'public, max-age=30');
    } finally {
        await app.close();
    }
});

// ---- L5: e-mails per address ------------------------------------------------------------------------------------

test('e-mails to one address are limited across every client, other addresses are not affected', async () => {
    const { emailAddressLimiter } = await import('../middleware/rateLimiter.js');
    const app = await serve((a) => {
        a.set('trust proxy', true); // the test plays different clients with X-Forwarded-For
        a.use((await_, res, next) => next());
        a.use(async (req, res, next) => { const { default: express } = await import('express'); express.json()(req, res, next); });
        a.post('/mail', emailAddressLimiter, (req, res) => res.status(200).json({}));
    });
    const post = async (email, ip) => (await fetch(`http://127.0.0.1:${app.port}/mail`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ email })
    })).status;
    try {
        const statuses = [];
        for (let i = 0; i < 5; i++) statuses.push(await post('Victim@Example.com', `203.0.113.${i + 1}`));
        assert.deepEqual(statuses, [200, 200, 200, 429, 429]); // a different client each time, the same inbox
        assert.equal(await post('other@example.com', '203.0.113.50'), 200);
        assert.equal(await post(' victim@example.com ', '203.0.113.60'), 429); // case and spacing do not make a new address
    } finally {
        await app.close();
    }
});

// ---- L7: a bad token is not a server error ----------------------------------------------------------------------

test('requests with a bad token are refused with 401 and logged as one throttled warning, not an error each', async () => {
    const { default: logger } = await import('../utils/logger.js');
    const { protect } = await import('../middleware/auth.js');
    const calls = { error: 0, warn: 0 };
    const originals = { error: logger.error, warn: logger.warn };
    logger.error = () => { calls.error += 1; };
    logger.warn = () => { calls.warn += 1; };
    try {
        const refuse = async (header) => {
            let sent = null;
            const res = { status(c) { this.code = c; return this; }, json(b) { sent = { status: this.code, body: b }; } };
            await protect({ headers: { authorization: header } }, res, () => {});
            return sent;
        };
        const bad = [jwt.sign({ id: 'x' }, 'wrong-secret'), 'garbage.token.here', jwt.sign({ id: 'x' }, 'test-secret', { expiresIn: -10 })];
        for (let i = 0; i < 12; i++) {
            const r = await refuse(`Bearer ${bad[i % 3]}`);
            assert.equal(r.status, 401);
            assert.equal(r.body.code, 'UNAUTHORIZED');
        }
        assert.equal(calls.error, 0, 'a bad token is not a server error');
        assert.equal(calls.warn, 1, `12 refusals should be one warning, got ${calls.warn}`);
        const none = await refuse(undefined);
        assert.equal(none.body.code, 'UNAUTHORIZED');
    } finally {
        logger.error = originals.error;
        logger.warn = originals.warn;
    }
});
