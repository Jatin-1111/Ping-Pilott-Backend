// Run with: npm test
// Password hashing used to be bcryptjs, which runs on the event loop: 8 logins at once stalled every request for about
// 600 ms (and the monitor workers, when they run inside the API process). It is native bcrypt now, and sign-ups and every
// login attempt from one address are counted. No database: the limiters run on a tiny Express app.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import bcrypt from 'bcrypt';

// The limiters read these when middleware/rateLimiter.js is first loaded, so they are set before anything imports it
process.env.REGISTER_RATE_LIMIT_MAX = '3';
process.env.LOGIN_IP_RATE_LIMIT_MAX = '4';

// A hash made by the old bcryptjs 2.4.3 for 'legacy-Pass-123' at cost 10. Existing accounts hold hashes like this one.
const LEGACY_BCRYPTJS_HASH = '$2a$10$KA0oU2Dmzyv4KIZCemvAG.uxoEprlFo2T1F4yBsAG8olztznF8HpG';

test('a password hashed by the old bcryptjs still verifies', async () => {
    assert.equal(await bcrypt.compare('legacy-Pass-123', LEGACY_BCRYPTJS_HASH), true);
    assert.equal(await bcrypt.compare('wrong-password', LEGACY_BCRYPTJS_HASH), false);
});

test('new hashes round-trip and report their cost, which the sign-in re-hash relies on', async () => {
    const hash = await bcrypt.hash('Some-Pass-1', 10);
    assert.equal(await bcrypt.compare('Some-Pass-1', hash), true);
    assert.equal(bcrypt.getRounds(hash), 10);
    assert.equal(bcrypt.getRounds(LEGACY_BCRYPTJS_HASH), 10);
});

test('hashing does not stall the event loop', async () => {
    // a timer that should fire every 5 ms; while the loop is blocked it cannot
    let last = Date.now();
    let worstGap = 0;
    const timer = setInterval(() => {
        const now = Date.now();
        worstGap = Math.max(worstGap, now - last);
        last = now;
    }, 5);

    await Promise.all(Array.from({ length: 8 }, () => bcrypt.hash('Load-Test-Pass-1', 10)));
    clearInterval(timer);

    // bcryptjs blocked for several hundred ms here; the generous bound keeps this steady on a busy machine
    assert.ok(worstGap < 120, `the event loop was blocked for ${worstGap} ms while hashing`);
});

// ---- the limiters -----------------------------------------------------------------------------------------------

async function appWith(limiter, status) {
    const { default: express } = await import('express');
    const app = express();
    app.post('/hit', limiter, (req, res) => res.status(status).json({ ok: status < 400 }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const hit = async () => (await fetch(`http://127.0.0.1:${port}/hit`, { method: 'POST' })).status;
    return { hit, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('registerLimiter counts every sign-up from an address, including successful ones', async () => {
    const { registerLimiter } = await import('../middleware/rateLimiter.js');
    const app = await appWith(registerLimiter, 201); // every request "succeeds"
    try {
        const statuses = [];
        for (let i = 0; i < 5; i++) statuses.push(await app.hit());
        assert.deepEqual(statuses, [201, 201, 201, 429, 429]);
    } finally {
        await app.close();
    }
});

test('loginIpLimiter counts successful logins too (authLimiter skips them)', async () => {
    const { loginIpLimiter } = await import('../middleware/rateLimiter.js');
    const app = await appWith(loginIpLimiter, 200);
    try {
        const statuses = [];
        for (let i = 0; i < 6; i++) statuses.push(await app.hit());
        assert.deepEqual(statuses, [200, 200, 200, 200, 429, 429]);
    } finally {
        await app.close();
    }
});
