// Run with: npm test
// GET /install.sh, and the install commands the owner is shown with a new token.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { createInstallHandler } from '../routes/installRoute.js';
import { installLimiter } from '../middleware/rateLimiter.js';
import { apiBaseOf, installCommands, AGENT_IMAGE } from '../utils/hostMetrics.js';
import { generateToken } from '../utils/agentToken.js';

const assetPath = new URL('../assets/install.sh', import.meta.url);
const real = fs.readFileSync(assetPath, 'utf8');

// ── the script itself ──

test('the installer is a complete script: a shebang, strict mode, and one function called on the last line', () => {
    assert.ok(real.startsWith('#!/bin/sh\n'));
    assert.match(real, /^set -eu$/m);
    assert.ok(real.trimEnd().endsWith('main "$@"'), 'a download cut short cannot run half of it');
    assert.equal(real.split('main "$@"').length, 2, 'called once');
    assert.ok(!real.includes('\r'), 'no CRLF: sh cannot run it');
});

test('it checks what it downloads, installs for an unprivileged user, and never runs a download unchecked', () => {
    assert.match(real, /Checksum matches/);
    assert.match(real, /does not match its checksum/);
    assert.match(real, /--proto '=https'/);
    assert.match(real, /refusing to download over plain http/);
    assert.match(real, /User=\$SERVICE_USER/);
    assert.match(real, /NoNewPrivileges=true/);
    assert.match(real, /install -m 0600 -o "\$SERVICE_USER"/, 'the token is readable by the service user only');
});

test('when the agent repository is next to this one, the two copies of the installer are the same file', (t) => {
    const sibling = new URL('../../pingpilot-agent/install.sh', import.meta.url);
    if (!fs.existsSync(sibling)) return t.skip('the agent repository is not checked out next to this one');
    assert.equal(real, fs.readFileSync(sibling, 'utf8'), 'copy pingpilot-agent/install.sh to assets/install.sh');
});

// ── serving it ──

let server;
let base;
let enabled = true;
let script = real;
let reads = 0;

before(async () => {
    const app = express();
    app.get('/install.sh', installLimiter, createInstallHandler({ read: () => { reads += 1; return script; }, enabled: () => enabled }));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

test('it is served exactly as it is, as plain text a browser will show rather than run', async () => {
    const res = await fetch(`${base}/install.sh`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(res.headers.get('cache-control'), /max-age=\d+/);
    assert.equal(await res.text(), real);
});

test('it is read once, not for every request', async () => {
    const before = reads;
    await fetch(`${base}/install.sh`);
    await fetch(`${base}/install.sh`);
    assert.ok(reads - before <= 1);
});

test('with the feature switched off there is no installer', async () => {
    enabled = false;
    try {
        assert.equal((await fetch(`${base}/install.sh`)).status, 404);
    } finally {
        enabled = true;
    }
});

test('a truncated or foreign file is refused instead of served as the installer', async () => {
    for (const bad of ['', '#!/bin/sh\nset -eu\nmain() {\n', 'echo hello\n', real.replace(/main "\$@"\s*$/, '')]) {
        const app = express();
        app.get('/install.sh', createInstallHandler({ read: () => bad, enabled: () => true }));
        const s = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
        try {
            const res = await fetch(`http://127.0.0.1:${s.address().port}/install.sh`);
            assert.equal(res.status, 500, JSON.stringify(bad.slice(0, 30)));
            assert.ok(!(await res.text()).includes('set -eu'), 'none of it is sent');
        } finally {
            await new Promise((resolve) => s.close(resolve));
        }
    }
});

test('a file saved with Windows line endings is served with Unix ones', async () => {
    const app = express();
    app.get('/install.sh', createInstallHandler({ read: () => real.replace(/\n/g, '\r\n'), enabled: () => true }));
    const s = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
    try {
        const text = await (await fetch(`http://127.0.0.1:${s.address().port}/install.sh`)).text();
        assert.equal(text, real);
        assert.ok(!text.includes('\r'));
    } finally {
        await new Promise((resolve) => s.close(resolve));
    }
});

// ── the commands shown with a new token ──

const token = generateToken().token;

test('the address of the API is the one configured, or the one the request came to, and only a plain one', () => {
    assert.equal(apiBaseOf({ configured: 'https://api.example.com/' }), 'https://api.example.com');
    assert.equal(apiBaseOf({ configured: ' https://api.example.com:8443 ' }), 'https://api.example.com:8443');
    assert.equal(apiBaseOf({ protocol: 'https', host: 'ping.example.com' }), 'https://ping.example.com');
    assert.equal(apiBaseOf({ configured: 'https://configured.example', protocol: 'https', host: 'asked.example' }), 'https://configured.example', 'configured wins');
    assert.equal(apiBaseOf({ configured: 'not an address', protocol: 'https', host: 'asked.example' }), 'https://asked.example', 'a bad setting falls back');
});

test('an address with anything in it that could be more than an address is refused, not escaped', () => {
    const hostile = [
        'https://x.example; rm -rf /', 'https://x.example/path', 'https://x.example?q=1', "https://x'.example", 'https://x.example && curl evil|sh',
        'https://$(id).example', 'https://x.example`id`', 'ftp://x.example', 'javascript:alert(1)', 'https://', '//x.example', 'https://x y.example', 'https://user@x.example', 'https://x.example:99999999'
    ];
    for (const configured of hostile) assert.equal(apiBaseOf({ configured }), null, configured);
    assert.equal(apiBaseOf({ protocol: 'https', host: 'evil.example;reboot' }), null, 'the Host header is the caller\'s to set');
    assert.equal(apiBaseOf({ configured: 'https://x.example\n' }), 'https://x.example', 'trailing whitespace is trimmed, never passed on');
    assert.equal(apiBaseOf({ configured: 'https://x.example\nrm -rf /' }), null, 'a second line is not trimmed away');
    assert.equal(apiBaseOf({ protocol: 'https', host: 'evil.example;reboot' }), null, 'the Host header is the caller\'s to set');
    assert.equal(apiBaseOf({}), null);
    assert.equal(apiBaseOf(), null);
});

test('the install commands carry the token and the address and nothing else', () => {
    const cmd = installCommands({ token, base: 'https://api.example.com' });
    assert.equal(cmd.command, `curl -fsSL https://api.example.com/install.sh | sudo PINGPILOT_TOKEN=${token} sh -s -- --api https://api.example.com`);
    assert.match(cmd.docker, new RegExp(`^docker run -d --name pingpilot-agent --restart unless-stopped --pid=host --net=host --uts=host -v /:/host:ro `));
    assert.ok(cmd.docker.includes(`-e PINGPILOT_TOKEN=${token}`) && cmd.docker.includes('-e PINGPILOT_API=https://api.example.com') && cmd.docker.includes('-e PINGPILOT_HOST_ROOT=/host'));
    assert.ok(cmd.docker.endsWith(AGENT_IMAGE));
    for (const text of [cmd.command, cmd.docker]) assert.ok(!/[;&|`$"'\\\n]/.test(text.replace(/ \| sudo /, ' ')), 'no shell metacharacters but the one pipe');
});

test('with a token or an address that is not safe to put in a command there is no command', () => {
    assert.equal(installCommands({ token: 'ppa_oops', base: 'https://api.example.com' }), null);
    assert.equal(installCommands({ token: `${token}; reboot`, base: 'https://api.example.com' }), null);
    assert.equal(installCommands({ token, base: 'https://api.example.com; reboot' }), null);
    assert.equal(installCommands({ token, base: null }), null);
    assert.equal(installCommands({}), null);
    assert.equal(installCommands(), null);
});
