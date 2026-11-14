// Run with: npm test
// Sign-in protection beyond one address + one email: one address spraying many accounts, many addresses at one account, an
// unknown address answering as slowly as a real one, and who `trust proxy` believes. No database.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import bcrypt from 'bcrypt';
import { parseTrustProxy } from '../utils/trustProxy.js';

// read when middleware/rateLimiter.js is first loaded
process.env.AUTH_IP_FAILURE_MAX = '3';
process.env.AUTH_ACCOUNT_FAILURE_MAX = '4';

async function loginApp() {
    const { default: express } = await import('express');
    const { loginFailureIpLimiter, loginFailureAccountLimiter } = await import('../middleware/rateLimiter.js');
    const app = express();
    app.set('trust proxy', true); // so the test can play different client addresses with X-Forwarded-For
    app.use(express.json());
    app.post('/login', loginFailureIpLimiter, loginFailureAccountLimiter, (req, res) => {
        res.status(req.body.password === 'right' ? 200 : 401).json({});
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const login = async (email, password, ip) => (await fetch(`http://127.0.0.1:${port}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ email, password })
    })).status;
    return { login, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('one address failing against many different accounts is stopped', async () => {
    const app = await loginApp();
    try {
        const statuses = [];
        // limit 3 failures per address: different email each time, so the per-account limit is never close
        for (let i = 0; i < 5; i++) statuses.push(await app.login(`victim${i}@example.com`, 'Summer2026!', '203.0.113.10'));
        assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
        // a different address is not affected
        assert.equal(await app.login('victim9@example.com', 'x', '203.0.113.11'), 401);
    } finally {
        await app.close();
    }
});

test('many addresses failing against one account is stopped', async () => {
    const app = await loginApp();
    try {
        const statuses = [];
        // limit 4 failures per account: a different address each time, so the per-address limit is never close
        for (let i = 0; i < 6; i++) statuses.push(await app.login('target@example.com', `guess${i}`, `198.51.100.${i + 1}`));
        assert.deepEqual(statuses, [401, 401, 401, 401, 429, 429]);
        // another account is not affected
        assert.equal(await app.login('someone-else@example.com', 'x', '198.51.100.99'), 401);
    } finally {
        await app.close();
    }
});

test('the failure limits never count successful sign-ins', async () => {
    const app = await loginApp();
    try {
        for (let i = 0; i < 10; i++) assert.equal(await app.login('me@example.com', 'right', '192.0.2.1'), 200);
    } finally {
        await app.close();
    }
});

test('an account is the same account whatever the case or spacing of the email', async () => {
    const app = await loginApp();
    try {
        const statuses = [];
        const spellings = ['Case@Example.com', 'case@example.com', ' CASE@example.com ', 'case@EXAMPLE.com', 'case@example.com'];
        for (let i = 0; i < spellings.length; i++) statuses.push(await app.login(spellings[i], 'bad', `192.0.2.${100 + i}`));
        assert.deepEqual(statuses, [401, 401, 401, 401, 429]);
    } finally {
        await app.close();
    }
});

test('burnPasswordCheck takes about as long as a real check, and answers false', async () => {
    const { burnPasswordCheck } = await import('../models/User.js');
    const real = await bcrypt.hash('some-password', 10);
    const t0 = performance.now();
    await bcrypt.compare('wrong', real);
    const realMs = performance.now() - t0;

    await burnPasswordCheck('warm-up'); // the first call makes the throwaway hash
    const t1 = performance.now();
    const result = await burnPasswordCheck('wrong');
    const burnMs = performance.now() - t1;

    assert.equal(result, false);
    // not 4 ms against 76 ms: same order of magnitude (the bound is loose to stay steady on a busy machine)
    assert.ok(burnMs > realMs / 4, `burn ${burnMs.toFixed(1)} ms vs real ${realMs.toFixed(1)} ms`);
});

test('parseTrustProxy reads counts, booleans and address lists', () => {
    assert.equal(parseTrustProxy(undefined), 1);
    assert.equal(parseTrustProxy('0'), 0);
    assert.equal(parseTrustProxy('2'), 2);
    assert.equal(parseTrustProxy('true'), true);
    assert.equal(parseTrustProxy('false'), false);
    assert.equal(parseTrustProxy('uniquelocal'), 'uniquelocal');
    assert.equal(parseTrustProxy(' loopback, 10.0.0.0/8 '), 'loopback, 10.0.0.0/8');
});

test('naming the proxy means a direct client cannot choose its own address', async () => {
    const { default: express } = await import('express');
    const probe = async (trustProxy, connectingFrom, forwarded) => {
        const app = express();
        app.set('trust proxy', trustProxy);
        app.get('/ip', (req, res) => res.json({ ip: req.ip }));
        // simulate the connecting address: express reads it from the socket, so wrap the request
        app.use((req, res, next) => next());
        const server = http.createServer((req, res) => {
            Object.defineProperty(req.socket, 'remoteAddress', { value: connectingFrom, configurable: true });
            app(req, res);
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        const body = await (await fetch(`http://127.0.0.1:${port}/ip`, { headers: { 'x-forwarded-for': forwarded } })).json();
        await new Promise((resolve) => server.close(resolve));
        return body.ip;
    };

    // hop count: a client that connects directly decides its own address
    assert.equal(await probe(1, '203.0.113.7', '1.2.3.4'), '1.2.3.4');
    // naming private addresses as the proxy: the same direct client is NOT believed
    assert.equal(await probe('uniquelocal', '203.0.113.7', '1.2.3.4'), '203.0.113.7');
    // nginx (a private Docker address) is believed, and the client address behind it is used
    assert.equal(await probe('uniquelocal', '172.18.0.5', '198.51.100.9'), '198.51.100.9');
});
