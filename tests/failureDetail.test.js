// Run with: npm test
// A failure as the API gives it: stored with the check, the server and the incident, and shown as the plan allows.

import test from 'node:test';
import assert from 'node:assert/strict';
import { failureView } from '../utils/failureDetail.js';
import { hasDetailedDiagnosis } from '../utils/planFeatures.js';
import { checkExtras } from '../utils/checkRecord.js';
import { planCheckUpdate } from '../utils/alertDecision.js';
import { failureFields, recordStatusChange } from '../services/incidentService.js';
import { buildIncidentList } from '../utils/incidentList.js';
import { incidentEvidenceExpiry } from '../tasks/dataRetention.js';
import Server from '../models/Server.js';
import Incident from '../models/Incident.js';
import ServerCheck from '../models/ServerCheck.js';
import { MAX_SNIPPET_BYTES } from '../utils/evidence.js';

const NOW = new Date('2026-10-25T10:00:00Z');
const server = { url: 'https://shop.example.com', type: 'website' };
const evidence = { statusCode: 502, headers: { server: 'nginx' }, address: '203.0.113.7', snippet: 'Bad Gateway' };
const failure = { kind: 'http', statusCode: 502, error: 'HTTP 502: Bad Gateway', failedPhase: 'response', timings: { dns: 4, connect: 6, tls: 30, ttfb: 120, redirects: 0 }, evidence };

// ── the plan ──

test('paid plans and admins get the detail, free and unknown plans do not', () => {
    for (const plan of ['starter_monthly', 'starter_yearly', 'pro_monthly', 'business_yearly', 'pro']) assert.equal(hasDetailedDiagnosis({ subscription: { plan } }), true, plan);
    for (const plan of ['free', undefined, '', 'gold_monthly']) assert.equal(hasDetailedDiagnosis({ subscription: { plan } }), false, String(plan));
    assert.equal(hasDetailedDiagnosis({ role: 'admin', subscription: { plan: 'free' } }), true);
    for (const nobody of [null, undefined, {}]) assert.equal(hasDetailedDiagnosis(nobody), false, String(nobody));
});

// ── what a plan sees ──

test('a paid plan gets causes, checks, evidence and the timings', () => {
    const { diagnosis, failureDetail } = failureView({ failure, server, detailed: true });
    assert.ok(diagnosis.causes.length > 0 && diagnosis.checks.length > 0);
    assert.deepEqual(failureDetail, { failedPhase: 'response', timings: failure.timings, statusCode: 502, evidence });
    assert.equal('locked' in failureDetail, false);
});

test('a free plan gets the plain diagnosis, the step and the timings, never the evidence, and is told there is more', () => {
    const { diagnosis, failureDetail } = failureView({ failure, server, detailed: false });
    assert.deepEqual(Object.keys(diagnosis).sort(), ['action', 'cause', 'title']);
    assert.deepEqual(failureDetail, { failedPhase: 'response', timings: failure.timings, statusCode: 502, locked: true });
    assert.ok(!JSON.stringify({ diagnosis, failureDetail }).includes('Bad Gateway</'), 'nothing of the page');
    assert.ok(!JSON.stringify({ diagnosis, failureDetail }).includes('nginx'));
});

test('a failure from before any of this was recorded is the plain diagnosis and nothing else, on every plan', () => {
    for (const detailed of [true, false]) {
        const { diagnosis, failureDetail } = failureView({ failure: { kind: 'timeout', error: 'Timed out after 10s' }, server, detailed });
        assert.equal(diagnosis.title, 'The server did not answer in time');
        assert.equal(failureDetail, null);
        assert.deepEqual(diagnosis.causes ?? [], []);
    }
});

test('no failure, or only junk, is nothing', () => {
    assert.deepEqual(failureView(), { diagnosis: null, failureDetail: null });
    assert.deepEqual(failureView({ failure: {}, detailed: true }), { diagnosis: null, failureDetail: null });
    const junk = failureView({ failure: { kind: 'http', statusCode: 'x', failedPhase: 'nonsense', timings: 'a', evidence: 5 }, server, detailed: true });
    assert.equal(junk.failureDetail, null);
    assert.equal(junk.diagnosis.title, 'The server answered with an error');
});

test('evidence that is stored too long or with a cookie comes out cut and clean', () => {
    const { failureDetail } = failureView({
        failure: { ...failure, evidence: { headers: { 'set-cookie': 'sid=1', server: 'nginx' }, snippet: 'x'.repeat(5000) } },
        server,
        detailed: true
    });
    assert.deepEqual(Object.keys(failureDetail.evidence.headers), ['server']);
    assert.equal(failureDetail.evidence.snippet.length, MAX_SNIPPET_BYTES);
    assert.equal(failureDetail.evidence.snippetTruncated, true);
});

// ── stored with the check ──

test('a failed check is saved with its step and evidence, and a check that worked with neither', () => {
    const down = checkExtras({ failure: { kind: 'http' }, statusCode: 502, failedPhase: 'response', evidence, timings: { dns: 4, connect: 6 } });
    assert.equal(down.failedPhase, 'response');
    assert.deepEqual(down.evidence, evidence);
    assert.deepEqual(down.timings, { dns: 4, connect: 6 });

    const up = checkExtras({ statusCode: 200, failedPhase: 'response', evidence, timings: { dns: 4 } });
    assert.equal('failedPhase' in up, false, 'only a failure has a failed step');
    assert.equal('evidence' in up, false);

    const odd = checkExtras({ failure: { kind: 'dns' }, failedPhase: 'nonsense', evidence: 'x' });
    assert.equal('failedPhase' in odd, false);
    assert.equal('evidence' in odd, false);
});

test('the check row accepts the new fields, and the server and incident rows hide the evidence unless asked', () => {
    const row = new ServerCheck({ serverId: '65f000000000000000000001', status: 'down', failedPhase: 'response', evidence, timings: { dns: 4, connect: 6, ttfb: 50 } });
    assert.equal(row.validateSync(), undefined);
    assert.equal(row.evidence.statusCode, 502);

    assert.equal(Server.schema.path('failureEvidence').options.select, false);
    assert.equal(Incident.schema.path('evidence').options.select, false);
    for (const field of ['failedPhase', 'failureStatusCode', 'failureTimings']) assert.notEqual(Server.schema.path(field).options.select, false, field);
});

// ── stored on the server ──

test('a failing check puts the failure on the server, and the next check that works clears it', () => {
    const base = { _id: 's1', status: 'up', monitoring: {}, slowStreak: 0, fastStreak: 0 };
    const down = planCheckUpdate({ server: base, checkResult: { status: 'down', responseTime: null, error: 'HTTP 502', failure: { kind: 'http' }, statusCode: 502, failedPhase: 'response', timings: { dns: 4, connect: 6, tls: 0, ttfb: 50, redirects: 0 }, evidence }, now: NOW });
    assert.equal(down.$set.failedPhase, 'response');
    assert.equal(down.$set.failureStatusCode, 502);
    assert.deepEqual(down.$set.failureTimings, { dns: 4, connect: 6, tls: 0, ttfb: 50, redirects: 0 });
    assert.deepEqual(down.$set.failureEvidence, evidence);

    const up = planCheckUpdate({ server: { ...base, status: 'down' }, checkResult: { status: 'up', responseTime: 120, error: null, failure: null, statusCode: 200, timings: { dns: 4 } }, now: NOW });
    for (const field of ['failedPhase', 'failureStatusCode', 'failureTimings', 'failureEvidence']) assert.equal(up.$set[field], null, field);
});

// ── stored on the incident ──

test('an incident keeps the first failure\'s step, status, timings and evidence, and only what is usable', () => {
    assert.deepEqual(failureFields({ failedPhase: 'tls', statusCode: 525, timings: { dns: 3, tls: 900 }, evidence }), { failedPhase: 'tls', statusCode: 525, timings: { dns: 3, tls: 900 }, evidence });
    assert.deepEqual(failureFields({}), {});
    assert.deepEqual(failureFields({ failedPhase: 'nope', statusCode: 'x', timings: {}, evidence: 7 }), {});
    assert.deepEqual(failureFields(), {});
});

test('going down opens an incident that carries them, and an incident without detail is saved as before', async () => {
    const created = [];
    const model = { create: async (doc) => { created.push(doc); }, updateOne: async () => {} };
    const owner = { _id: 'srv1', uploadedBy: 'user1', name: 'Shop' };

    await recordStatusChange(owner, 'up', { status: 'down', error: 'HTTP 502', failure: { kind: 'http' }, statusCode: 502, failedPhase: 'response', timings: { dns: 4, ttfb: 50 }, evidence }, NOW, model);
    assert.equal(created[0].failedPhase, 'response');
    assert.equal(created[0].statusCode, 502);
    assert.deepEqual(created[0].timings, { dns: 4, ttfb: 50 });
    assert.deepEqual(created[0].evidence, evidence);

    await recordStatusChange(owner, 'up', { status: 'down', error: 'Timed out' }, NOW, model);
    for (const field of ['failedPhase', 'statusCode', 'timings', 'evidence']) assert.equal(field in created[1], false, field);
});

// ── the incident list ──

const row = (extra = {}) => ({ _id: 'i1', serverId: 'srv1', userId: 'u1', startedAt: new Date('2026-10-24T09:00:00Z'), endedAt: null, open: true, error: 'HTTP 502', failureKind: 'http', failedPhase: 'response', statusCode: 502, timings: { dns: 4, ttfb: 50 }, evidence, ...extra });
const servers = [{ _id: 'srv1', name: 'Shop', url: 'https://shop.example.com', type: 'website' }];

test('the incident list carries the detail on a paid plan', () => {
    const [incident] = buildIncidentList([row()], servers, { now: NOW.getTime(), detailed: true }).incidents;
    assert.ok(incident.diagnosis.causes.length > 0);
    assert.deepEqual(incident.failureDetail, { failedPhase: 'response', timings: { dns: 4, ttfb: 50 }, statusCode: 502, evidence });
});

test('and on a free plan it has the plain diagnosis and a locked note, and the same fields as before', () => {
    const [incident] = buildIncidentList([row()], servers, { now: NOW.getTime() }).incidents;
    assert.deepEqual(Object.keys(incident.diagnosis).sort(), ['action', 'cause', 'title']);
    assert.equal(incident.failureDetail.locked, true);
    assert.equal('evidence' in incident.failureDetail, false);
    assert.equal(incident.error, 'HTTP 502');
    assert.equal(incident.failureKind, 'http');
});

test('an incident from before any of this has no failureDetail, and its diagnosis reads as it did', () => {
    const [incident] = buildIncidentList([row({ failedPhase: undefined, statusCode: undefined, timings: undefined, evidence: undefined, failureKind: 'dns', error: 'DNS lookup failed' })], servers, { now: NOW.getTime(), detailed: true }).incidents;
    assert.equal('failureDetail' in incident, false);
    assert.equal(incident.diagnosis.title, 'The domain name could not be found');
});

// ── retention ──

test('the evidence on old incidents is removed with the checks, and nothing else about them', () => {
    const cutoff = new Date('2026-10-18T00:00:00Z');
    const { filter, update } = incidentEvidenceExpiry(cutoff);
    assert.deepEqual(filter, { startedAt: { $lt: cutoff }, evidence: { $ne: null } });
    assert.deepEqual(update, { $unset: { evidence: '' } });
});
