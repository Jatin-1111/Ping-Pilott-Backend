// Run with: npm test
// Support tickets e-mail someone on every ticket and reply, and nothing limited either (15 tickets in a row all went through),
// and replies could grow a ticket document without end. No database.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ticketIsFull, MAX_CUSTOMER_REPLIES_PER_TICKET } from '../utils/ticketLimits.js';

// read when middleware/rateLimiter.js is first loaded
process.env.SUPPORT_TICKETS_PER_HOUR = '3';
process.env.SUPPORT_REPLIES_PER_HOUR = '2';

async function app(limiterName) {
    const { default: express } = await import('express');
    const limiters = await import('../middleware/rateLimiter.js');
    const server = express();
    // stand-in for `protect`: the user comes from a header
    server.use((req, res, next) => {
        req.user = { id: req.get('x-user'), role: req.get('x-role') || 'user' };
        next();
    });
    server.post('/hit', limiters[limiterName], (req, res) => res.status(201).json({}));
    const http_ = http.createServer(server);
    await new Promise((resolve) => http_.listen(0, '127.0.0.1', resolve));
    const { port } = http_.address();
    const hit = async (user, role) => (await fetch(`http://127.0.0.1:${port}/hit`, {
        method: 'POST',
        headers: { 'x-user': user, ...(role ? { 'x-role': role } : {}) }
    })).status;
    return { hit, close: () => new Promise((resolve) => http_.close(resolve)) };
}

test('a user is limited to a few new tickets an hour; other users are not affected', async () => {
    const a = await app('supportTicketLimiter');
    try {
        const statuses = [];
        for (let i = 0; i < 5; i++) statuses.push(await a.hit('user-1'));
        assert.deepEqual(statuses, [201, 201, 201, 429, 429]);
        assert.equal(await a.hit('user-2'), 201);
    } finally {
        await a.close();
    }
});

test('replies have their own, higher limit', async () => {
    const a = await app('supportReplyLimiter');
    try {
        const statuses = [];
        for (let i = 0; i < 4; i++) statuses.push(await a.hit('user-1'));
        assert.deepEqual(statuses, [201, 201, 429, 429]);
    } finally {
        await a.close();
    }
});

test('staff replying to many tickets are not limited', async () => {
    const a = await app('supportReplyLimiter');
    try {
        for (let i = 0; i < 6; i++) assert.equal(await a.hit('admin-1', 'admin'), 201);
    } finally {
        await a.close();
    }
});

test('a customer cannot add replies past the cap; staff can', () => {
    const full = { responses: new Array(MAX_CUSTOMER_REPLIES_PER_TICKET).fill({ message: 'x' }) };
    const almost = { responses: new Array(MAX_CUSTOMER_REPLIES_PER_TICKET - 1).fill({ message: 'x' }) };
    assert.equal(ticketIsFull(full, false), true);
    assert.equal(ticketIsFull(almost, false), false);
    assert.equal(ticketIsFull(full, true), false);
    assert.equal(ticketIsFull({}, false), false);
});
