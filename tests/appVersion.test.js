// Run with: npm test
// Which mobile build is current. The answer comes from environment variables and is validated, because the app opens
// the download link it is given.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVersionInfo } from '../utils/appVersion.js';

test('with nothing configured, everything is null', () => {
    assert.deepEqual(buildVersionInfo({}), { latestVersionCode: null, minVersionCode: null, downloadUrl: null, notes: null });
});

test('configured values come through', () => {
    const info = buildVersionInfo({
        APP_LATEST_VERSION_CODE: '7',
        APP_MIN_VERSION_CODE: ' 5 ',
        APP_DOWNLOAD_URL: 'https://expo.dev/accounts/me/projects/app/builds/abc',
        APP_RELEASE_NOTES: '  Snooze buttons on alerts  ',
    });
    assert.deepEqual(info, {
        latestVersionCode: 7,
        minVersionCode: 5,
        downloadUrl: 'https://expo.dev/accounts/me/projects/app/builds/abc',
        notes: 'Snooze buttons on alerts',
    });
});

test('version codes must be whole positive numbers', () => {
    for (const bad of ['', 'abc', '0', '-3', '2.5', 'NaN', '1e3x']) {
        assert.equal(buildVersionInfo({ APP_LATEST_VERSION_CODE: bad }).latestVersionCode, null, `"${bad}"`);
    }
    assert.equal(buildVersionInfo({ APP_LATEST_VERSION_CODE: '12' }).latestVersionCode, 12);
});

test('only https download links are passed on', () => {
    for (const bad of ['http://example.com/app.apk', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://x/y', 'not a url', 'https://']) {
        assert.equal(buildVersionInfo({ APP_DOWNLOAD_URL: bad }).downloadUrl, null, bad);
    }
    assert.equal(buildVersionInfo({ APP_DOWNLOAD_URL: 'HTTPS://Example.com/a b' }).downloadUrl, 'https://example.com/a%20b');
});

test('long release notes are cut to 300 characters', () => {
    assert.equal(buildVersionInfo({ APP_RELEASE_NOTES: 'x'.repeat(1000) }).notes.length, 300);
    assert.equal(buildVersionInfo({ APP_RELEASE_NOTES: '   ' }).notes, null);
});
