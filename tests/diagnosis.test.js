// Run with: npm test
// A failed check is also said in plain words: what happened, the likely cause, what to try first. The raw error sentence
// is untouched and still shown beside it. Every kind the classifier can return either has a diagnosis or deliberately has none.

import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, diagnosisLines } from '../utils/diagnosis.js';
import { FAILURE_KINDS } from '../utils/failures.js';
import { buildIncidentList } from '../utils/incidentList.js';
import { sendAlertChannels } from '../services/alertService.js';
import { getAlertEmailContent } from '../services/emailService.js';

const hasShape = (d) => d && ['title', 'cause', 'action'].every((k) => typeof d[k] === 'string' && d[k].length > 10);

test('every kind except "other" has a diagnosis, and "other" and no failure have none', () => {
    for (const kind of FAILURE_KINDS) {
        if (kind === 'other') assert.equal(diagnose({ kind }), null);
        else assert.ok(hasShape(diagnose({ kind, statusCode: kind === 'http' ? 500 : undefined, error: 'x' })), kind);
    }
    assert.equal(diagnose({}), null);
    assert.equal(diagnose(), null);
    assert.equal(diagnose({ kind: 'something-new' }), null, 'a kind added later without wording says nothing rather than something wrong');
});

test('an HTTP failure is explained by its status code', () => {
    assert.match(diagnose({ kind: 'http', statusCode: 502 }).title, /app behind it is not answering/);
    assert.match(diagnose({ kind: 'http', statusCode: 503 }).cause, /overloaded, in maintenance mode/);
    assert.match(diagnose({ kind: 'http', statusCode: 504 }).title, /took too long/);
    assert.match(diagnose({ kind: 'http', statusCode: 500 }).cause, /application bug/);
    assert.match(diagnose({ kind: 'http', statusCode: 404 }).title, /not found/);
    assert.match(diagnose({ kind: 'http', statusCode: 521 }).title, /521/, 'an unlisted 5xx still names its status');
    assert.match(diagnose({ kind: 'http', statusCode: 418 }).title, /Unexpected response \(418\)/);
});

test('a login wall, a bot filter or a rate limit says the site is alive and where to change it', () => {
    for (const code of [401, 403, 429]) {
        const d = diagnose({ kind: 'http', statusCode: code });
        assert.match(d.cause, /site is alive/);
        assert.ok(d.action.includes(String(code)), code);
    }
});

test('an HTTP failure saved without a status reads it from the sentence, and without either it stays generic', () => {
    assert.match(diagnose({ kind: 'http', error: 'HTTP 502: Bad Gateway' }).title, /app behind it/);
    assert.ok(hasShape(diagnose({ kind: 'http', error: 'something unrelated' })));
    assert.ok(hasShape(diagnose({ kind: 'http' })));
});

test('a certificate failure says which problem it is, from the library message', () => {
    assert.match(diagnose({ kind: 'tls', error: 'certificate has expired' }).title, /expired/);
    assert.match(diagnose({ kind: 'tls', error: "Hostname/IP does not match certificate's altnames: Host: a.com. is not in the cert's altnames" }).title, /does not match/);
    assert.match(diagnose({ kind: 'tls', error: 'self-signed certificate' }).title, /self-signed/);
    assert.match(diagnose({ kind: 'tls', error: 'unable to verify the first certificate' }).title, /chain is incomplete/);
    assert.match(diagnose({ kind: 'tls', error: 'handshake failed' }).title, /secure connection could not be made/);
    assert.ok(hasShape(diagnose({ kind: 'tls' })), 'no message at all still reads');
});

test('the wording only ever claims a likely cause, never a certain one', () => {
    for (const kind of ['dns', 'refused', 'reset', 'timeout', 'unreachable', 'content']) {
        assert.match(diagnose({ kind }).cause, /\b(likely|may|often|usual|usually|common)\b/i, kind);
    }
});

test('the plain-text lines are three, and empty without a diagnosis', () => {
    const lines = diagnosisLines(diagnose({ kind: 'refused' }));
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^What happened: /);
    assert.match(lines[1], /^Likely cause: /);
    assert.match(lines[2], /^Try first: /);
    assert.deepEqual(diagnosisLines(null), []);
});

test('the incident list carries the diagnosis next to the error, and an incident from before the kind has none', () => {
    const NOW = new Date('2026-10-25T10:00:00Z');
    const list = buildIncidentList(
        [{ _id: 'i1', serverId: 's1', startedAt: NOW, endedAt: null, open: true, error: 'HTTP 502: Bad Gateway', failureKind: 'http' },
         { _id: 'i2', serverId: 's1', startedAt: NOW, endedAt: null, open: true, error: 'old' }],
        [{ _id: 's1', name: 'Shop', url: 'shop.example' }],
        { now: NOW.getTime() }
    );
    assert.match(list.incidents[0].diagnosis.title, /app behind it/);
    assert.equal(list.incidents[0].error, 'HTTP 502: Bad Gateway', 'the sentence is still there');
    assert.equal(list.incidents[1].diagnosis, null);
});

test('the webhook payload adds the diagnosis to the fields it always had', async () => {
    let payload;
    const server = { _id: 's1', name: 'Shop', url: 'shop.example', status: 'up', contactEmails: [], monitoring: { alerts: { webhookUrl: 'https://hooks.example/x' } } };
    const down = { status: 'down', error: 'HTTP 503: Service Unavailable', failureKind: 'http', statusCode: 503 };
    await sendAlertChannels(server, 'server_down', down, {}, { sendWebhook: async (_s, _t, body) => { payload = body; }, sendEmail: async () => {} });
    assert.equal(payload.error, 'HTTP 503: Service Unavailable');
    assert.equal(payload.failureKind, 'http');
    assert.equal(payload.statusCode, 503);
    assert.match(payload.diagnosis.cause, /overloaded/);

    // a recovery, or a down alert from a row with no kind, has no diagnosis key
    await sendAlertChannels(server, 'server_recovery', { status: 'up' }, {}, { sendWebhook: async (_s, _t, body) => { payload = body; }, sendEmail: async () => {} });
    assert.equal('diagnosis' in payload, false);
    await sendAlertChannels(server, 'server_down', { status: 'down', error: 'x' }, {}, { sendWebhook: async (_s, _t, body) => { payload = body; }, sendEmail: async () => {} });
    assert.equal('diagnosis' in payload, false);
});

test('the down email shows the diagnosis above the error, escaped, and keeps the error line', () => {
    const server = { name: 'Shop', url: 'shop.example', error: 'HTTP 502: <b>Bad</b>', failureKind: 'http', statusCode: 502 };
    const { html } = getAlertEmailContent(server, 'server_down', 'up', 'down');
    assert.match(html, /Likely cause/);
    assert.match(html, /app behind it is not answering/);
    assert.match(html, /Error: HTTP 502: &lt;b&gt;Bad&lt;\/b&gt;/);

    const plain = getAlertEmailContent({ name: 'Shop', url: 'shop.example', error: 'x' }, 'server_down', 'up', 'down').html;
    assert.equal(plain.includes('Likely cause'), false, 'no kind, no diagnosis block');
    assert.match(plain, /Error: x/);
});
