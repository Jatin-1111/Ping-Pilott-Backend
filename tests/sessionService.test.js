// Run with: npm test
// Sessions the server can end: refresh tokens are accepted once and replaced, a copied token ends its whole sign-in, logout
// and "sign out everywhere" work, and tokens from before this change keep working once. No database: a fake model with the
// handful of calls the service uses. Real jsonwebtoken, test secrets.

import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { createSessionService, SessionError } from '../services/sessionService.js';
import { checkSessionClaims } from '../utils/sessionClaims.js';

const SECRETS = { access: 'test-access-secret', refresh: 'test-refresh-secret' };

function fakeRefreshModel() {
    const docs = new Map();
    const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => (v === null ? doc[k] == null : String(doc[k]) === String(v)));
    return {
        docs,
        async create(doc) { docs.set(doc._id, { usedAt: null, revokedAt: null, ...doc }); },
        async updateOne(filter, update, options) {
            if (docs.has(filter._id)) return; // $setOnInsert changes nothing when the record exists
            if (options?.upsert) docs.set(filter._id, { _id: filter._id, ...update.$setOnInsert });
        },
        async findOneAndUpdate(filter, update) {
            const doc = [...docs.values()].find((d) => matches(d, filter));
            if (!doc) return null;
            const before = { ...doc };
            Object.assign(doc, update.$set);
            return before; // like Mongoose: the document as it was before the update
        },
        findById(id) { return { lean: async () => (docs.has(id) ? { ...docs.get(id) } : null) }; },
        async updateMany(filter, update) {
            for (const doc of docs.values()) if (matches(doc, filter)) Object.assign(doc, update.$set);
        }
    };
}

function setup(extra = {}) {
    const model = fakeRefreshModel();
    let t = 1_000_000;
    const clock = { now: () => t, advance: (ms) => { t += ms; } };
    let n = 0;
    const service = createSessionService({
        RefreshToken: model, secrets: () => SECRETS, now: clock.now, randomId: () => `id-${++n}`, leewayMs: () => 10_000, ...extra
    });
    return { model, clock, service };
}

const user = { _id: 'user-1', tokenVersion: 0 };

test('issue gives an access token and a tracked refresh token', async () => {
    const { model, service } = setup();
    const { token, refreshToken } = await service.issue(user);
    const access = jwt.verify(token, SECRETS.access);
    const refresh = jwt.verify(refreshToken, SECRETS.refresh);
    assert.equal(access.id, 'user-1');
    assert.equal(access.tv, 0);
    assert.ok(refresh.jti && refresh.fam);
    assert.equal(model.docs.get(refresh.jti).family, refresh.fam);
});

test('the access token is short-lived by default', async () => {
    delete process.env.JWT_EXPIRES_IN; // the default applies only when this is not set
    const { service } = setup();
    const { token } = await service.issue(user);
    const { iat, exp } = jwt.decode(token);
    assert.equal(exp - iat, 3600);
});

test('a refresh token is accepted once and the next one stays in the same sign-in', async () => {
    const { service } = setup();
    const first = await service.issue(user);
    const decoded = service.verifyRefresh(first.refreshToken);
    const { family } = await service.consume(decoded);
    assert.equal(family, decoded.fam);
    const second = await service.issue(user, family);
    assert.equal(service.verifyRefresh(second.refreshToken).fam, decoded.fam);
});

test('a retry just after use is allowed (the answer may have been lost)', async () => {
    const { clock, service } = setup();
    const decoded = service.verifyRefresh((await service.issue(user)).refreshToken);
    await service.consume(decoded);
    clock.advance(3000);
    const again = await service.consume(decoded);
    assert.equal(again.replay, true);
});

test('a copied token shown after the leeway ends the whole sign-in, including the newest token', async () => {
    const { clock, service } = setup();
    const first = await service.issue(user);
    const decoded = service.verifyRefresh(first.refreshToken);
    const { family } = await service.consume(decoded);
    const newest = await service.issue(user, family); // what the real owner now holds

    clock.advance(60_000);
    await assert.rejects(service.consume(decoded), (err) => err instanceof SessionError && err.code === 'REUSED');

    // the family is revoked, so the owner's newest token no longer works either
    const newestDecoded = service.verifyRefresh(newest.refreshToken);
    await assert.rejects(service.consume(newestDecoded), (err) => err.code === 'REVOKED');
});

test('reuse in one sign-in does not touch the same user\'s other devices', async () => {
    const { clock, service } = setup();
    const phone = service.verifyRefresh((await service.issue(user)).refreshToken);
    const laptop = service.verifyRefresh((await service.issue(user)).refreshToken);
    assert.notEqual(phone.fam, laptop.fam);

    await service.consume(phone);
    clock.advance(60_000);
    await assert.rejects(service.consume(phone), (err) => err.code === 'REUSED');
    assert.ok((await service.consume(laptop)).family); // still fine
});

test('a token with no record is refused', async () => {
    const { service } = setup();
    const forged = jwt.sign({ id: 'user-1', jti: 'never-issued', fam: 'x' }, SECRETS.refresh, { expiresIn: '7d' });
    await assert.rejects(service.consume(service.verifyRefresh(forged)), (err) => err.code === 'UNKNOWN');
});

test('a token signed with the wrong secret or expired is refused', async () => {
    const { service } = setup();
    assert.throws(() => service.verifyRefresh(jwt.sign({ id: 'u' }, 'other-secret')), (err) => err.code === 'INVALID');
    const expired = jwt.sign({ id: 'u', jti: 'j' }, SECRETS.refresh, { expiresIn: -10 });
    assert.throws(() => service.verifyRefresh(expired), (err) => err.code === 'INVALID');
});

test('a token issued before sessions were tracked is accepted and replaced by a tracked one', async () => {
    const { model, service } = setup();
    const legacy = jwt.sign({ id: 'user-1' }, SECRETS.refresh, { expiresIn: '7d' }); // no jti, no tv
    const decoded = service.verifyRefresh(legacy);
    const { family, legacy: isLegacy } = await service.consume(decoded, legacy);
    assert.equal(isLegacy, true);
    const next = await service.issue(user, family);
    assert.equal(model.docs.size, 2); // the legacy token's record and the new tracked token
    assert.ok(service.verifyRefresh(next.refreshToken).jti);
});

test('a copy of a token from before sessions were tracked is caught like any other', async () => {
    const { clock, service } = setup();
    const legacy = jwt.sign({ id: 'user-1' }, SECRETS.refresh, { expiresIn: '7d' });
    const decoded = service.verifyRefresh(legacy);
    const { family } = await service.consume(decoded, legacy);
    const newest = await service.issue(user, family);

    clock.advance(3000);
    assert.equal((await service.consume(decoded, legacy)).replay, true); // a retry just after
    clock.advance(60_000);
    await assert.rejects(service.consume(decoded, legacy), (err) => err.code === 'REUSED');
    // and the sign-in it started is over, including the token the real owner holds now
    await assert.rejects(service.consume(service.verifyRefresh(newest.refreshToken)), (err) => err.code === 'REVOKED');
});

test('two different legacy tokens do not share a record', async () => {
    const { service } = setup();
    const a = jwt.sign({ id: 'user-1', jti: undefined, n: 1 }, SECRETS.refresh, { expiresIn: '7d' });
    const b = jwt.sign({ id: 'user-1', n: 2 }, SECRETS.refresh, { expiresIn: '7d' });
    const fa = (await service.consume(service.verifyRefresh(a), a)).family;
    const fb = (await service.consume(service.verifyRefresh(b), b)).family;
    assert.notEqual(fa, fb);
});

test('logout revokes the sign-in and is quiet about tokens that are already dead', async () => {
    const { service } = setup();
    const { refreshToken } = await service.issue(user);
    assert.equal(await service.logout(refreshToken), true);
    await assert.rejects(service.consume(service.verifyRefresh(refreshToken)), (err) => err.code === 'REVOKED');

    assert.equal(await service.logout('not-a-token'), false);
    const expired = jwt.sign({ id: 'u', jti: 'j', fam: 'f' }, SECRETS.refresh, { expiresIn: -10 });
    assert.equal(await service.logout(expired), true); // an expired token can still end its sign-in
    assert.equal(await service.logout(jwt.sign({ id: 'u' }, SECRETS.refresh)), false); // legacy: nothing to revoke
});

test('revokeUser ends every device of that user and nobody else', async () => {
    const { service } = setup();
    const a1 = service.verifyRefresh((await service.issue(user)).refreshToken);
    const a2 = service.verifyRefresh((await service.issue(user)).refreshToken);
    const other = service.verifyRefresh((await service.issue({ _id: 'user-2' })).refreshToken);
    await service.revokeUser('user-1');
    await assert.rejects(service.consume(a1), (err) => err.code === 'REVOKED');
    await assert.rejects(service.consume(a2), (err) => err.code === 'REVOKED');
    assert.ok((await service.consume(other)).family);
});

test('tokens carry the user\'s tokenVersion', async () => {
    const { service } = setup();
    const { token, refreshToken } = await service.issue({ _id: 'user-1', tokenVersion: 3 });
    assert.equal(jwt.decode(token).tv, 3);
    assert.equal(jwt.decode(refreshToken).tv, 3);
});

// ---- the shared session rule (REST, refresh and the socket handshake) ----------------------------------------

test('a token from before "sign out everywhere" is refused', () => {
    assert.equal(checkSessionClaims({ tokenVersion: 2 }, { tv: 1, iat: 100 }).code, 'session_ended');
    assert.equal(checkSessionClaims({ tokenVersion: 2 }, { tv: 2, iat: 100 }), null);
});

test('tokens and accounts from before tokenVersion existed read as version 0', () => {
    assert.equal(checkSessionClaims({}, { iat: 100 }), null);
    assert.equal(checkSessionClaims({ tokenVersion: 0 }, { iat: 100 }), null);
    assert.equal(checkSessionClaims({ tokenVersion: 1 }, { iat: 100 }).code, 'session_ended');
});

test('a token from before a password change is refused, one issued after it is not', () => {
    const changedAt = new Date(2_000_000_000_000);
    const before = Math.floor(changedAt.getTime() / 1000) - 5;
    const after = Math.floor(changedAt.getTime() / 1000) + 5;
    assert.equal(checkSessionClaims({ passwordChangedAt: changedAt }, { tv: 0, iat: before }).code, 'password_changed');
    assert.equal(checkSessionClaims({ passwordChangedAt: changedAt }, { tv: 0, iat: after }), null);
});
