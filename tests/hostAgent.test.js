// Run with: npm test
// Host agents end to end, over real HTTP with the database swapped for in-memory fakes: the owner turns an agent on and
// gets a token once, the agent signs in with it and sends snapshots, and every wrong door stays shut.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { createAgentAuth } from '../middleware/agentAuth.js';
import { agentLimiter, agentGuessLimiter } from '../middleware/rateLimiter.js';
import { createHostAgentController } from '../controllers/hostAgentController.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { hostMetricsAllowance } from '../utils/planFeatures.js';
import { generateToken, parseToken } from '../utils/agentToken.js';
import Server from '../models/Server.js';

const GB = 1024 ** 3;
const NOW = Date.parse('2026-10-26T12:00:00Z');

// ── a small world: servers, owners, what was stored ──

const owners = {
    pro: { _id: 'u-pro', role: 'user', subscription: { plan: 'pro_monthly' } },
    starter: { _id: 'u-starter', role: 'user', subscription: { plan: 'starter_yearly' } },
    free: { _id: 'u-free', role: 'user', subscription: { plan: 'free' } },
    admin: { _id: 'u-admin', role: 'admin', subscription: { plan: 'free' } },
    other: { _id: 'u-other', role: 'user', subscription: { plan: 'pro_monthly' } }
};

// a server id has to look like one (24 hex characters), so tests name servers and these turn the names into ids
const id = (name) => crypto.createHash('md5').update(String(name)).digest('hex').slice(0, 24);

const world = { servers: [], points: [], rollups: [], flag: true, now: NOW, alerts: [], saves: 0, canAlert: true, failNextSave: false };
const reset = () => {
    world.servers = []; world.points = []; world.rollups = []; world.flag = true; world.now = NOW;
    world.alerts = []; world.saves = 0; world.canAlert = true; world.failNextSave = false;
};
const addServer = (name, owner, agent) => { const s = { _id: id(name), name: `Server ${name}`, uploadedBy: owner._id, ...(agent ? { agent } : {}) }; world.servers.push(s); return s; };
const withAgent = (name, owner, extra = {}) => {
    const t = generateToken();
    addServer(name, owner, { enabled: true, tokenId: t.tokenId, tokenHash: t.tokenHash, ...extra });
    return t.token;
};

// the few Mongo update operators the controller uses
const apply = (server, update) => {
    for (const [path, value] of Object.entries(update.$set ?? {})) {
        const [head, leaf] = path.split('.');
        if (leaf) { server[head] = { ...server[head], [leaf]: value }; } else { server[path] = value; }
    }
    for (const path of Object.keys(update.$unset ?? {})) {
        const [head, leaf] = path.split('.');
        if (leaf) { if (server[head]) delete server[head][leaf]; } else { delete server[path]; }
    }
};
const byId = (nameOrId) => world.servers.find((s) => String(s._id) === String(nameOrId) || String(s._id) === id(nameOrId));

const deps = {
    findServer: async (tokenId) => world.servers.find((s) => s.agent?.tokenId === tokenId) ?? null,
    findOwner: async (ownerId) => Object.values(owners).find((o) => o._id === ownerId) ?? null,
    enabled: () => world.flag
};
const controller = createHostAgentController({
    ...deps,
    insertPoints: async (docs) => { world.points.push(...docs); },
    touchServer: async (serverId, set) => apply(byId(serverId), { $set: set }),
    findServer: async (serverId) => byId(serverId) ?? null,
    countAgents: async (ownerId, exceptId) => world.servers.filter((s) => s.uploadedBy === ownerId && s.agent?.enabled && s._id !== exceptId).length,
    saveAgent: async (serverId, update) => apply(byId(serverId), update),
    deletePoints: async (serverId) => {
        world.points = world.points.filter((p) => String(p.serverId) !== String(serverId));
        world.rollups = world.rollups.filter((r) => String(r.serverId) !== String(serverId));
    },
    readRaw: async (serverId, from, limit = 1500) => world.points
        .filter((p) => String(p.serverId) === String(serverId) && p.timestamp >= from)
        .sort((a, b) => a.timestamp - b.timestamp).slice(-limit),
    readRollups: async (serverId, from) => world.rollups
        .filter((r) => String(r.serverId) === String(serverId) && r.bucket >= from).sort((a, b) => a.bucket - b.bucket),
    readLatest: async (serverId) => world.points.filter((p) => String(p.serverId) === String(serverId)).sort((a, b) => b.timestamp - a.timestamp)[0] ?? null,
    forgetCache: async () => {},
    // the alert side: the state is saved only if nobody has saved it since it was read, like the real save
    saveReading: async (serverId, set, rev) => {
        world.saves += 1;
        if (world.failNextSave) { world.failNextSave = false; return false; }
        const s = byId(serverId);
        if ((s.agent?.alertsRev ?? null) !== (rev ?? null)) return false;
        apply(s, { $set: set });
        s.agent.alertsRev = (s.agent.alertsRev ?? 0) + 1;
        return true;
    },
    shouldSend: () => world.canAlert,
    enqueueAlert: async (args) => { world.alerts.push(args); },
    now: () => world.now
});

let base;
let httpServer;
before(async () => {
    const app = express();
    app.use(express.json({ limit: '10kb' }));
    // the agent's door
    app.post('/api/agent/v1/metrics', agentGuessLimiter, agentLimiter, createAgentAuth(deps), asyncHandler(controller.ingest));
    // the owner's door: a test header says who is signed in
    app.use('/api/servers/:id', (req, res, next) => { req.user = { ...owners[req.get('x-user')], id: owners[req.get('x-user')]?._id }; next(); });
    app.get('/api/servers/:id/metrics', asyncHandler(controller.metrics));
    app.post('/api/servers/:id/agent', asyncHandler(controller.enable));
    app.post('/api/servers/:id/agent/rotate', asyncHandler(controller.rotate));
    app.delete('/api/servers/:id/agent', asyncHandler(controller.disable));
    app.use((err, req, res, next) => res.status(err.status || 500).json({ status: 'error', message: err.message })); // eslint-disable-line no-unused-vars
    await new Promise((resolve) => { httpServer = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${httpServer.address().port}`;
});
after(() => new Promise((resolve) => httpServer.close(resolve)));

const snapshot = (extra = {}) => ({
    cpu: { percent: 40, cores: 2, load: [0.4, 0.5, 0.6] },
    mem: { total: 4 * GB, used: GB },
    disks: [{ mount: '/', total: 50 * GB, used: 10 * GB }],
    uptimeSec: 1000,
    ...extra
});
const payload = (snapshots = [snapshot()]) => ({ v: 1, host: { name: 'web-1', os: 'linux', arch: 'amd64', agentVersion: '0.1.0' }, snapshots });

const send = (token, body = payload(), headers = {}) => fetch(`${base}/api/agent/v1/metrics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
});
const metrics = (name, who, query = '') => fetch(`${base}/api/servers/${id(name)}/metrics${query}`, { headers: { 'x-user': who } });
const owner = (method, name, who, path = '') => fetch(`${base}/api/servers/${/^[0-9a-f]{24}$/.test(name) ? name : id(name)}/agent${path}`, { method, headers: { 'x-user': who } });
const json = async (res) => ({ status: res.status, body: await res.json() });

// ── the agent sends ──

test('a snapshot with a good token is stored against that server, and the server shows when it was last heard from', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    const { status, body } = await json(await send(token));
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'success', data: { accepted: 1, nextIntervalSec: 60, minAgentVersion: '0.1.0' } });
    assert.equal(world.points.length, 1);
    assert.equal(world.points[0].serverId, id('s1'));
    assert.deepEqual(world.points[0].timestamp, new Date(NOW));
    assert.deepEqual(byId('s1').agent.lastSeenAt, new Date(NOW));
    assert.equal(byId('s1').agent.hostname, 'web-1');
    assert.equal(byId('s1').agent.version, '0.1.0');
});

test('a batch the agent kept while it was offline is stored whole, in order', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    const at = (min) => new Date(NOW - min * 60000).toISOString();
    const batch = [5, 4, 3, 2, 1].map((m) => snapshot({ ts: at(m) }));
    const { body } = await json(await send(token, payload(batch)));
    assert.equal(body.data.accepted, 5);
    assert.equal(world.points.length, 5);
    assert.deepEqual(world.points.map((p) => NOW - p.timestamp.getTime()), [300000, 240000, 180000, 120000, 60000]);
    assert.ok(world.points.every((p) => p.serverId === id('s1')));
});

test('a token can only ever write to its own server, whatever the body says', async () => {
    reset();
    const mine = withAgent('mine', owners.pro);
    withAgent('theirs', owners.other);
    await send(mine, { ...payload(), serverId: 'theirs' }); // refused: unknown field
    await send(mine, payload());
    assert.ok(world.points.every((p) => p.serverId === id('mine')));
    assert.equal(world.points.length, 1);
});

// ── every wrong door ──

test('no token, a malformed one, an unknown one and a wrong secret are all refused the same way, and nothing is stored', async () => {
    reset();
    const good = withAgent('s1', owners.pro);
    const { tokenId } = parseToken(good);
    const wrongSecret = `ppa_${tokenId}_${'A'.repeat(43)}`;
    const unknown = generateToken().token;

    const answers = [];
    for (const token of [null, 'nonsense', unknown, wrongSecret]) {
        const r = await json(await send(token));
        assert.equal(r.status, 401, String(token));
        answers.push(JSON.stringify(r.body));
    }
    assert.equal(new Set(answers).size, 1, 'the answer does not say which part was wrong');
    assert.equal(world.points.length, 0);
    assert.equal(byId('s1').agent.lastSeenAt, undefined);
});

test('an agent that was turned off, and a token that was replaced, are refused', async () => {
    reset();
    const off = withAgent('s1', owners.pro, { enabled: false });
    assert.equal((await send(off)).status, 401);

    const first = withAgent('s2', owners.pro);
    const created = await json(await owner('POST', 's2', 'pro', '/rotate'));
    assert.equal(created.status, 200);
    assert.equal((await send(first)).status, 401, 'the old token');
    assert.equal((await send(created.body.data.token)).status, 200, 'the new token');
});

test('an account on a plan without host metrics is refused with a reason, and nothing is stored', async () => {
    reset();
    const token = withAgent('s1', owners.free);
    const { status, body } = await json(await send(token));
    assert.equal(status, 403);
    assert.equal(body.code, 'PLAN_REQUIRED');
    assert.equal(world.points.length, 0);
});

test('with the feature switched off the endpoint does not exist', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    world.flag = false;
    assert.equal((await send(token)).status, 404);
    assert.equal(world.points.length, 0);
    assert.equal((await owner('POST', 's1', 'pro')).status, 404);
});

test('a body that is not in the expected format is refused with 422 and nothing is stored', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    const cases = [
        payload([snapshot({ cpu: { percent: 500, cores: 2 } })]),
        { ...payload(), v: 2 },
        { ...payload(), extra: true },
        payload([]),
        payload([snapshot({ procs: [{ name: 'a\nb', cpu: 1, mem: 1 }] })])
    ];
    for (const body of cases) {
        const r = await json(await send(token, body));
        assert.equal(r.status, 422);
        assert.equal(r.body.code, 'INVALID_PAYLOAD');
        assert.ok(Array.isArray(r.body.issues));
    }
    assert.equal((await send(token, '{ not json')).status, 400);
    assert.equal(world.points.length, 0);
});

test('a body bigger than the limit is refused before it is read', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    const huge = payload([snapshot({ disks: [{ mount: 'x'.repeat(20000), total: 1, used: 1 }] })]);
    assert.equal((await send(token, huge)).status, 413);
    assert.equal(world.points.length, 0);
});

// ── the limit is per token ──

test('one token has its own limit, and another behind the same address is not held up by it', async () => {
    reset();
    const noisy = withAgent('noisy', owners.pro);
    const quiet = withAgent('quiet', owners.pro);
    const statuses = [];
    for (let i = 0; i < 14; i += 1) statuses.push((await send(noisy)).status);
    assert.equal(statuses.filter((s) => s === 200).length, 12);
    assert.deepEqual(statuses.slice(12), [429, 429]);
    assert.equal((await send(quiet)).status, 200, 'same address, different token');
});

// ── the owner's controls ──

test('turning it on makes a token that is shown once, stored only as a hash, and that works', async () => {
    reset();
    addServer('s1', owners.pro);
    const { status, body } = await json(await owner('POST', 's1', 'pro'));
    assert.equal(status, 201);
    const { token } = body.data;
    assert.match(token, /^ppa_[0-9a-f]{24}_/);
    assert.equal(body.data.agent.enabled, true);

    const stored = byId('s1').agent;
    assert.equal(stored.enabled, true);
    assert.match(stored.tokenHash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(world.servers).includes(parseToken(token).secret), 'the secret is nowhere in what is stored');

    assert.equal((await send(token)).status, 200, 'it signs in');
});

test('the response that makes a token also has the commands that install it, built from that token and this API\'s address', async () => {
    reset();
    addServer('s1', owners.pro);
    const { body } = await json(await owner('POST', 's1', 'pro'));
    const { token, install } = body.data;
    assert.ok(install.command.includes(`PINGPILOT_TOKEN=${token}`));
    assert.ok(install.command.startsWith(`curl -fsSL ${base}/install.sh | sudo `), 'the address the request came to');
    assert.ok(install.docker.includes(`-e PINGPILOT_TOKEN=${token}`) && install.docker.includes(`-e PINGPILOT_API=${base}`));

    const rotated = await json(await owner('POST', 's1', 'pro', '/rotate'));
    assert.ok(rotated.body.data.install.command.includes(rotated.body.data.token), 'and a new token has its own');
    assert.ok(!rotated.body.data.install.command.includes(token), 'not the old one');
});

test('it cannot be turned on twice: that is what replacing the token is for', async () => {
    reset();
    addServer('s1', owners.pro);
    assert.equal((await owner('POST', 's1', 'pro')).status, 201);
    const again = await json(await owner('POST', 's1', 'pro'));
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'AGENT_EXISTS');
    assert.ok(!('token' in (again.body.data ?? {})));
});

test('replacing the token clears what the old install had reported', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    await send(token);
    assert.ok(byId('s1').agent.lastSeenAt);
    await owner('POST', 's1', 'pro', '/rotate');
    assert.equal(byId('s1').agent.lastSeenAt, undefined);
    assert.equal(byId('s1').agent.hostname, undefined);
    assert.equal(byId('s1').agent.enabled, true);
});

test('turning it off stops the agent at once and deletes what it sent', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    await send(token);
    withAgent('s2', owners.pro);
    world.points.push({ serverId: id('s2'), cpu: 1 });
    assert.equal(world.points.length, 2);

    const r = await json(await owner('DELETE', 's1', 'pro'));
    assert.equal(r.status, 200);
    assert.equal(byId('s1').agent, undefined);
    assert.deepEqual(world.points.map((p) => p.serverId), [id('s2')], 'only that server\'s data');
    assert.equal((await send(token)).status, 401);
});

test('nobody but the owner (or an admin) can turn it on, replace it or turn it off', async () => {
    reset();
    addServer('s1', owners.pro);
    const token = withAgent('s2', owners.pro);
    for (const [method, path, id] of [['POST', '', 's1'], ['POST', '/rotate', 's2'], ['DELETE', '', 's2']]) {
        const r = await json(await owner(method, id, 'other', path));
        assert.equal(r.status, 403, `${method} ${path}`);
    }
    assert.equal(byId('s1').agent, undefined);
    assert.equal((await send(token)).status, 200, 'the agent was not touched');
    assert.equal((await fetch(`${base}/api/servers/nope/agent`, { method: 'POST', headers: { 'x-user': 'pro' } })).status, 400, 'not an id');
    assert.equal((await owner('POST', '65f0000000000000000000ff', 'pro')).status, 404);
    assert.equal((await owner('POST', 's1', 'admin')).status, 201, 'an admin may');
});

test('a free plan cannot turn it on, and a plan with a cap cannot go past it', async () => {
    reset();
    addServer('f1', owners.free);
    const free = await json(await owner('POST', 'f1', 'free'));
    assert.equal(free.status, 403);
    assert.equal(free.body.code, 'PLAN_REQUIRED');
    assert.equal(byId('f1').agent, undefined);

    for (const id of ['a', 'b', 'c']) withAgent(id, owners.starter);
    addServer('d', owners.starter);
    const over = await json(await owner('POST', 'd', 'starter'));
    assert.equal(over.status, 403);
    assert.equal(over.body.code, 'AGENT_LIMIT');
    assert.match(over.body.message, /3 servers/);

    // replacing a token on a server that already has one is not "one more"
    assert.equal((await owner('POST', 'a', 'starter', '/rotate')).status, 200);
    // and turning one off makes room
    await owner('DELETE', 'a', 'starter');
    assert.equal((await owner('POST', 'd', 'starter')).status, 201);
});

test('rotating where host metrics are not on is refused', async () => {
    reset();
    addServer('s1', owners.pro);
    const r = await json(await owner('POST', 's1', 'pro', '/rotate'));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'AGENT_NOT_ENABLED');
});

// ── the plan table and the stored fields ──

test('paid plans and admins can have agents, with a cap; free and unknown plans cannot', () => {
    const allow = (plan, role) => hostMetricsAllowance({ role, subscription: { plan } });
    assert.deepEqual(allow('free'), { enabled: false, maxServers: 0 });
    assert.deepEqual(allow('starter_monthly'), { enabled: true, maxServers: 3 });
    assert.deepEqual(allow('pro_yearly'), { enabled: true, maxServers: 15 });
    assert.deepEqual(allow('business_monthly'), { enabled: true, maxServers: 60 });
    assert.equal(allow('gold').enabled, false);
    assert.equal(allow(undefined).enabled, false);
    assert.equal(allow('free', 'admin').enabled, true);
    assert.equal(hostMetricsAllowance(null).enabled, false);
});

test('the token id and hash are not in a server unless asked for, so no list or detail can carry them', () => {
    assert.equal(Server.schema.path('agent.tokenHash').options.select, false);
    assert.equal(Server.schema.path('agent.tokenId').options.select, false);
    for (const field of ['enabled', 'lastSeenAt', 'version', 'hostname']) assert.notEqual(Server.schema.path(`agent.${field}`).options.select, false, field);
    const query = Server.find({});
    query._applyPaths();
    assert.equal(query._fields['agent.tokenHash'], 0);
    assert.equal(query._fields['agent.tokenId'], 0);
});

// ── reading it back ──

const minutesAgo = (min) => new Date(NOW - min * 60000);
const stored = (name, min, extra = {}) => ({
    serverId: id(name), timestamp: minutesAgo(min), cpu: 40, cores: 2, load1: 0.5, load5: 0.6, load15: 0.7,
    memTotal: 4 * GB, memUsed: GB, disks: [{ mount: '/', total: 100 * GB, used: 40 * GB }], rxBps: 100, txBps: 50, uptimeSec: 500, ...extra
});

test('a server with no agent has an empty, honest answer and the page can offer to set one up', async () => {
    reset();
    addServer('s1', owners.pro);
    const { status, body } = await json(await metrics('s1', 'pro'));
    assert.equal(status, 200);
    assert.equal(body.data.agent.status, 'off');
    assert.deepEqual([body.data.series, body.data.latest, body.data.mounts], [[], null, []]);
});

test('the agent is waiting until its first snapshot, then connected, then offline when it goes quiet', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    assert.equal((await json(await metrics('s1', 'pro'))).body.data.agent.status, 'waiting');

    await send(token);
    const connected = (await json(await metrics('s1', 'pro'))).body.data;
    assert.equal(connected.agent.status, 'connected');
    assert.equal(connected.agent.hostname, 'web-1');
    assert.equal(connected.agent.version, '0.1.0');

    world.now = NOW + 10 * 60000;
    assert.equal((await json(await metrics('s1', 'pro'))).body.data.agent.status, 'offline');
});

test('a short range is the raw snapshots, with the latest one in full', async () => {
    reset();
    withAgent('s1', owners.pro);
    world.points.push(stored('s1', 90), stored('s1', 30, { cpu: 10 }), stored('s1', 5, { cpu: 80, memUsed: 3 * GB }));
    const { body } = await json(await metrics('s1', 'pro', '?period=1h'));
    const d = body.data;
    assert.equal(d.period, '1h');
    assert.equal(d.binSeconds, 0);
    assert.deepEqual(d.series.map((p) => p.cpu), [10, 80], 'the one from 90 minutes ago is outside the hour');
    assert.equal(d.series[1].memPct, 75);
    assert.deepEqual(d.mounts, ['/']);
    assert.equal(d.latest.cpu, 80);
    assert.equal(d.latest.mem.pct, 75);
    assert.deepEqual(d.latest.disks, [{ mount: '/', total: 100 * GB, used: 40 * GB, pct: 40 }]);
});

test('a long range is the stored 5-minute rows plus what came in since, in steps of five minutes for a day', async () => {
    reset();
    withAgent('s1', owners.pro);
    const bucket = (min) => new Date(Math.floor((NOW - min * 60000) / 300000) * 300000);
    const row = (min, cpu) => ({ serverId: id('s1'), bucket: bucket(min), n: 5, cpu, cpuMax: cpu + 10, memPct: 25, memPctMax: 30, disks: [{ mount: '/', total: 100, pct: 40 }] });
    world.rollups.push(row(120, 20), row(115, 30));
    const lastEnd = bucket(115).getTime() + 300000;
    world.points.push({ ...stored('s1', 0), timestamp: new Date(lastEnd + 60000), cpu: 100 }); // not rolled yet
    const { body } = await json(await metrics('s1', 'pro')); // default: 24h
    const d = body.data;
    assert.equal(d.period, '24h');
    assert.equal(d.binSeconds, 300);
    assert.deepEqual(d.series.map((p) => p.cpu), [20, 30, 100], 'the unrolled end of the chart is not missing');
    assert.equal(d.series[0].cpuMax, 30);
});

test('seven days and thirty days come back in coarser steps', async () => {
    reset();
    withAgent('s1', owners.pro);
    const day = 24 * 60 * 60000;
    const row = (ago, cpu) => ({ serverId: id('s1'), bucket: new Date(Math.floor((NOW - ago) / 300000) * 300000), n: 1, cpu, cpuMax: cpu, memPct: 10, memPctMax: 10, disks: [] });
    world.rollups.push(row(6 * day, 10), row(6 * day - 300000, 30), row(2 * day, 50));
    const week = (await json(await metrics('s1', 'pro', '?period=7d'))).body.data;
    assert.equal(week.binSeconds, 1800);
    assert.equal(week.series.length, 2);
    assert.equal(week.series[0].cpu, 20, 'two rows in one step are averaged');
    assert.equal((await json(await metrics('s1', 'pro', '?period=30d'))).body.data.binSeconds, 7200);
});

test('a range that does not exist is a bad request, including names that are not ranges at all', async () => {
    reset();
    withAgent('s1', owners.pro);
    for (const period of ['1y', '', 'constructor', '__proto__', 'toString', '24H', '24h%00']) {
        const r = await json(await metrics('s1', 'pro', `?period=${encodeURIComponent(period)}`));
        assert.equal(r.status, 400, period);
        assert.equal(r.body.code, 'INVALID_PERIOD');
    }
});

test('only the owner, an admin, and a plan that has host metrics can read them', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    await send(token);
    assert.equal((await metrics('s1', 'other')).status, 403);
    assert.equal((await metrics('s1', 'admin')).status, 200);
    assert.equal((await fetch(`${base}/api/servers/65f0000000000000000000ff/metrics`, { headers: { 'x-user': 'pro' } })).status, 404);

    withAgent('s2', owners.free);
    world.points.push(stored('s2', 1));
    const r = await json(await metrics('s2', 'free'));
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'PLAN_REQUIRED');
    assert.equal(r.body.data.series, undefined, 'no data comes with the refusal');
    assert.equal(r.body.data.latest, undefined);

    world.flag = false;
    assert.equal((await metrics('s1', 'pro')).status, 404);
});

test('what is read back never carries the token, its id or its hash', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    await send(token);
    world.points.push(stored('s1', 1));
    const text = await (await metrics('s1', 'pro', '?period=1h')).text();
    const { tokenId, secret } = parseToken(token);
    for (const secretish of [token, tokenId, secret, byId('s1').agent.tokenHash]) assert.ok(!text.includes(secretish));
});

test('turning the agent off also deletes the rolled-up rows, and the page goes back to its empty state', async () => {
    reset();
    withAgent('s1', owners.pro);
    withAgent('s2', owners.pro);
    world.points.push(stored('s1', 1), stored('s2', 1));
    world.rollups.push({ serverId: id('s1'), bucket: minutesAgo(10), n: 1 }, { serverId: id('s2'), bucket: minutesAgo(10), n: 1 });
    await owner('DELETE', 's1', 'pro');
    assert.deepEqual(world.rollups.map((r) => r.serverId), [id('s2')]);
    assert.deepEqual(world.points.map((p) => p.serverId), [id('s2')]);
    const after = (await json(await metrics('s1', 'pro'))).body.data;
    assert.deepEqual([after.agent.status, after.series, after.latest], ['off', [], null]);
});

// ── alerts, from the readings an agent sends ──

const sendAt = (token, minutesAgo, cpuPercent = 97, extra = {}) => send(token, payload([snapshot({
    ts: new Date(NOW - minutesAgo * 60000).toISOString(), cpu: { percent: cpuPercent, cores: 2 }, ...extra
})]));
const raised = () => world.alerts.map((a) => [a.alertType, a.checkResult.host.recovered]);

test('CPU over the limit for five minutes raises one alert, however many readings follow', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    for (const ago of [14, 13, 12, 11, 10, 9, 8, 7, 6]) assert.equal((await sendAt(token, ago)).status, 200);
    assert.deepEqual(raised(), [['host_cpu_high', false]]);
    const [alert] = world.alerts;
    assert.equal(alert.checkResult.host.value, 97);
    assert.equal(alert.checkResult.host.threshold, 90);
    assert.equal(alert.checkResult.host.minutes, 5);
    assert.equal(String(alert.server._id), id('s1'));
    assert.equal(alert.server.uploadedBy, owners.pro._id);
    assert.equal(world.saves, 9);
    assert.equal(byId('s1').agent.alerts.cpu.alerted, true);
});

test('when it comes back down it raises one more, which says it is the end', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    for (const ago of [14, 13, 12, 11, 10, 9]) await sendAt(token, ago);
    for (const ago of [8, 7]) await sendAt(token, ago, 20);
    assert.deepEqual(raised(), [['host_cpu_high', false], ['host_cpu_high', true]]);
    assert.equal(world.alerts[1].checkResult.host.lasted, 1);
    assert.equal(byId('s1').agent.alerts.cpu.alerted, false);
});

test('a spike shorter than the limit raises nothing', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    for (const [ago, cpu] of [[10, 99], [9, 99], [8, 99], [7, 10], [6, 10]]) await sendAt(token, ago, cpu);
    assert.deepEqual(world.alerts, []);
});

test('the owner\'s own limits are used, over the defaults', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    byId('s1').monitoring = { hostAlerts: { cpu: { percent: 50, minutes: 0 } } };
    await sendAt(token, 1, 60);
    assert.deepEqual(raised(), [['host_cpu_high', false]]);
    assert.equal(world.alerts[0].checkResult.host.threshold, 50);
});

test('with host alerts switched off nothing is raised', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    byId('s1').monitoring = { hostAlerts: { enabled: false } };
    for (const ago of [14, 13, 12, 11, 10, 9, 8]) await sendAt(token, ago);
    assert.deepEqual(world.alerts, []);
});

test('memory and disk are judged too, each with its own alert', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    const full = { mem: { total: 4 * GB, used: Math.round(3.8 * GB) }, disks: [{ mount: '/data', total: 100 * GB, used: 96 * GB }] };
    for (const ago of [14, 13, 12, 11, 10, 9]) await sendAt(token, ago, 10, full);
    assert.deepEqual(raised().map(([type]) => type).sort(), ['host_disk_high', 'host_memory_high']);
    const disk = world.alerts.find((a) => a.alertType === 'host_disk_high');
    assert.equal(disk.checkResult.host.mount, '/data');
});

test('when the owner cannot be told right now, nothing is raised and nothing is used up', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    world.canAlert = false;
    for (const ago of [14, 13, 12, 11, 10, 9, 8]) await sendAt(token, ago);
    assert.deepEqual(world.alerts, []);
    assert.equal(byId('s1').agent.alerts.cpu.alerted, false);
    world.canAlert = true;
    await sendAt(token, 7);
    assert.deepEqual(raised(), [['host_cpu_high', false]], 'told at the first reading after they can be');
});

test('two readings judged at once cannot both raise the alert: the one that loses the save raises nothing', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    for (const ago of [14, 13, 12, 11, 10]) await sendAt(token, ago);
    world.failNextSave = true; // the reading that would complete the five minutes loses the race
    const lost = await sendAt(token, 9);
    assert.equal(lost.status, 200, 'the agent is still told it arrived');
    assert.deepEqual(world.alerts, [], 'and it raised nothing');
    assert.equal(world.points.length, 6, 'what it sent is stored');
    await sendAt(token, 8); // the next reading judges from the state that is saved
    assert.deepEqual(raised(), [['host_cpu_high', false]], 'and the alert is raised once, one reading later');
});

test('a problem with the alert side never makes the agent send the same readings again', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    const broken = createHostAgentController({
        ...deps,
        insertPoints: async (docs) => { world.points.push(...docs); },
        touchServer: async (serverId, set) => apply(byId(serverId), { $set: set }),
        saveReading: async () => { throw new Error('the database is busy'); },
        shouldSend: () => true,
        enqueueAlert: async () => {},
        now: () => world.now
    });
    const app = express();
    app.use(express.json({ limit: '10kb' }));
    app.post('/m', createAgentAuth(deps), asyncHandler(broken.ingest));
    const s = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
    try {
        const res = await fetch(`http://127.0.0.1:${s.address().port}/m`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload()) });
        assert.equal(res.status, 200);
        assert.equal(world.points.length, 1);
        assert.ok(byId('s1').agent.lastSeenAt, 'it is still recorded as seen');
    } finally {
        await new Promise((resolve) => s.close(resolve));
    }
});

test('an agent reporting again after a "no data" alert says so, once', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    byId('s1').agent.alerts = { missing: { alerted: true, alertedAt: NOW - 8 * 60000, since: NOW - 12 * 60000 } };
    await sendAt(token, 0, 10);
    await sendAt(token, 0, 10);
    assert.deepEqual(raised(), [['host_metrics_missing', true]]);
    assert.equal(world.alerts[0].checkResult.host.minutes, 12);
    assert.equal(byId('s1').agent.alerts.missing.alerted, false);
});

test('a reading with nothing wrong in it changes no alert state beyond remembering what it saw', async () => {
    reset();
    const token = withAgent('s1', owners.pro);
    await sendAt(token, 1, 10);
    assert.deepEqual(world.alerts, []);
    assert.equal(byId('s1').agent.alerts.cpu.alerted, false);
    assert.equal(byId('s1').agent.alerts.cpu.since, null);
});

// Last: it uses up this address's allowance for refused requests, which would hold back the tests after it
test('guessing tokens runs out, however many different ids are tried, and working agents are never counted', async () => {
    reset();
    const working = withAgent('works', owners.pro);
    // (earlier tests have used some of this address's allowance, so only the shape is asserted)
    const statuses = [];
    for (let i = 0; i < 40; i += 1) statuses.push((await send(generateToken().token)).status); // a fresh, well-formed id each time
    assert.ok(statuses.includes(429), 'it runs out');
    assert.ok(!statuses.includes(200), 'and none of the guesses worked');
    const firstLimited = statuses.indexOf(429);
    assert.ok(statuses.slice(0, firstLimited).every((s) => s === 401));
    assert.ok(statuses.slice(firstLimited).every((s) => s === 429), 'once limited it stays limited');
    assert.ok(firstLimited <= 30, 'after at most 30 refusals');
    void working;
});
