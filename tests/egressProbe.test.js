// Run with: npm test
// Regression for F10: when the worker host lost its own network, every monitored server failed, was confirmed down by
// a second failed try, and every owner got a DOWN email, then a RECOVERY email when the network came back.
// No network: the control connections and the DNS lookup are fakes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEgressProbe, EgressDownError, probeSettings, DEFAULT_TARGETS, DEFAULT_DNS_NAME } from '../services/egressProbe.js';
import { runCheck } from '../services/checkRunner.js';
import { evaluatePipeline } from '../services/pipelineHealth.js';

const settings = () => ({ enabled: true, targets: ['1.1.1.1:443', '8.8.8.8:443'], dnsName: 'cloudflare.com' });
const DOWN = { status: 'down', responseTime: null, error: 'Connection refused', slow: false };
const UP = { status: 'up', responseTime: 100, error: null, slow: false };

const probeWith = ({ tcpUp = ['1.1.1.1:443', '8.8.8.8:443'], dnsUp = true, clock = { t: 1_000_000 } } = {}) => {
    const seen = { tcp: 0, dns: 0 };
    const probe = createEgressProbe({
        settings,
        tcp: async (target) => { seen.tcp += 1; if (!tcpUp.includes(target)) throw new Error(`${target} unreachable`); },
        lookup: async () => { seen.dns += 1; if (!dnsUp) throw new Error('ENOTFOUND'); },
        now: () => clock.t,
    });
    return { probe, seen, clock };
};

test('the network is up when a control address answers and the name resolves', async () => {
    assert.equal(await probeWith().probe.isUp(), true);
});

test('one control address being down is fine as long as another answers', async () => {
    assert.equal(await probeWith({ tcpUp: ['8.8.8.8:443'] }).probe.isUp(), true);
});

test('no control address answering means our network is down', async () => {
    assert.equal(await probeWith({ tcpUp: [] }).probe.isUp(), false);
});

test('a resolver that does not work means our network is down, even if the addresses answer', async () => {
    assert.equal(await probeWith({ dnsUp: false }).probe.isUp(), false);
});

test('fifty failing checks cause one probe, and an answer is reused until it is too old', async () => {
    const { probe, seen, clock } = probeWith();
    await Promise.all(Array.from({ length: 50 }, () => probe.isUp(15000)));
    assert.equal(seen.dns, 1, 'one probe for all fifty');

    clock.t += 10_000;
    await probe.isUp(15000);
    assert.equal(seen.dns, 1, '10 s old is fresh enough for 15 s');
    await probe.isUp(5000);
    assert.equal(seen.dns, 2, '10 s old is too old for 5 s');
});

test('the probe reports its result so /health can show it', async () => {
    const { probe } = probeWith({ tcpUp: [] });
    const reports = [];
    probe.setReporter((up) => reports.push(up));
    await probe.isUp();
    assert.deepEqual(reports, [false]);
});

test('a reporter that throws does not break the probe', async () => {
    const { probe } = probeWith();
    probe.setReporter(() => { throw new Error('redis down'); });
    assert.equal(await probe.isUp(), true);
});

test('switched off, or with private targets allowed, the probe always says up and does not run', async () => {
    const seen = { tcp: 0 };
    const probe = createEgressProbe({ settings: () => ({ ...settings(), enabled: false }), tcp: async () => { seen.tcp += 1; throw new Error('x'); }, lookup: async () => { throw new Error('x'); } });
    assert.equal(await probe.isUp(), true);
    assert.equal(seen.tcp, 0);
});

test('settings: defaults, overrides and the off switch', () => {
    const base = probeSettings({});
    assert.deepEqual(base.targets, DEFAULT_TARGETS);
    assert.equal(base.dnsName, DEFAULT_DNS_NAME);
    assert.equal(base.enabled, true);
    assert.deepEqual(probeSettings({ EGRESS_PROBE_TARGETS: ' 9.9.9.9:443 , 1.0.0.1:443 ' }).targets, ['9.9.9.9:443', '1.0.0.1:443']);
    assert.equal(probeSettings({ EGRESS_PROBE_DNS: 'example.org' }).dnsName, 'example.org');
    assert.equal(probeSettings({ EGRESS_PROBE: 'false' }).enabled, false);
});

// --- runCheck uses it ---

const run = (server, answers, { up = [true], delayMs = 10000 } = {}) => {
    let calls = 0;
    let probes = 0;
    const waits = [];
    const options = {
        check: async () => answers[Math.min(calls++, answers.length - 1)],
        sleep: async (ms) => { waits.push(ms); },
        delayMs,
        isEgressUp: async () => up[Math.min(probes++, up.length - 1)],
    };
    return { options, get calls() { return calls; }, get probes() { return probes; }, waits };
};

test('a failure while our network is down throws, before waiting for the confirmation, and records nothing', async () => {
    const h = run({ status: 'up' }, [DOWN], { up: [false] });
    await assert.rejects(runCheck({ status: 'up' }, h.options), (err) => err instanceof EgressDownError && err.code === 'EGRESS_DOWN');
    assert.equal(h.calls, 1, 'no second check');
    assert.deepEqual(h.waits, [], 'no wait holding a worker slot');
});

test('a failure while the network is fine is confirmed as before', async () => {
    const h = run({ status: 'up' }, [DOWN, DOWN], { up: [true, true] });
    const result = await runCheck({ status: 'up' }, h.options);
    assert.equal(result.status, 'down');
    assert.equal(h.calls, 2);
    assert.equal(h.probes, 2, 'asked once before the wait and once after the second failure');
});

test('the network dying during the confirmation wait is caught by the second probe', async () => {
    const h = run({ status: 'up' }, [DOWN, DOWN], { up: [true, false] });
    await assert.rejects(runCheck({ status: 'up' }, h.options), EgressDownError);
});

test('an up result never probes', async () => {
    const h = run({ status: 'up' }, [UP], { up: [false] });
    assert.equal((await runCheck({ status: 'up' }, h.options)).status, 'up');
    assert.equal(h.probes, 0);
});

test('a server already down is probed too, so a dead network does not add down history points', async () => {
    const h = run({ status: 'down' }, [DOWN], { up: [false] });
    await assert.rejects(runCheck({ status: 'down' }, h.options), EgressDownError);
    const fine = run({ status: 'down' }, [DOWN], { up: [true] });
    assert.equal((await runCheck({ status: 'down' }, fine.options)).status, 'down');
    assert.equal(fine.calls, 1, 'already down: no confirmation');
});

test('the error tells the user it was our side', () => {
    assert.match(new EgressDownError().message, /cannot reach the internet/);
});

// --- health ---

test('/health/monitoring reports egress-down as degraded', () => {
    const now = Date.UTC(2026, 9, 24, 12, 0, 0);
    const result = evaluatePipeline({ now, startedAt: now - 3_600_000, schedulerStatus: 'ok', monitorWorkers: 1, alertWorkers: 1, lastCheckCompletedAt: now - 5000, egressDown: true, dispatches: [] });
    assert.equal(result.state, 'degraded');
    assert.deepEqual(result.reasons, ['egress-down']);
});
