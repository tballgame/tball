import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequestPost as account } from './functions/api/account.js';
import { onRequestPost as registration } from './functions/api/registration.js';
import { openCatalog } from './firebase-store.mjs';
import { readSession, sessionCookie } from './firebase-auth.mjs';
import { firebaseConfig } from './firebaseConfig.js';

const projectId = firebaseConfig.projectId;
const origin = 'https://tball-test.example';
const enabled = { fields: { projectId: { stringValue: projectId }, productId: { stringValue: 'tball' },
  registered: { booleanValue: true }, active: { booleanValue: true } } };
const env = { TBALL_SESSION_KEY: 'a'.repeat(43) };
function request(path, body, headers = {}) {
  return new Request(`${origin}/api/${path}`, { method: 'POST', headers: { Origin: origin, ...headers }, body: JSON.stringify(body) });
}

test('disabled club blocks both routes, but logout clears a browser session', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...enabled, fields: {
    ...enabled.fields, active: { booleanValue: false }
  } }));
  assert.equal((await account({ request: request('account', { action: 'signup' }), env })).status, 403);
  assert.equal((await registration({ request: request('registration', { action: 'view' }), env })).status, 403);
  const result = await account({ request: request('account', { action: 'logout' }), env });
  assert.match(result.headers.get('Set-Cookie'), /Max-Age=0/);
});

test('browser session cookie is encrypted, expires and rejects tampering', async () => {
  const expired = await sessionCookie(env, { expires: 1, code: 'private-code' });
  assert.match(expired, /Secure; HttpOnly; SameSite=Strict; Max-Age=0/);
  assert.equal(expired.includes('private-code'), false);
  assert.match((await readSession(request('account', {}, { Cookie: expired.split(';')[0] }), env)).cookie, /Max-Age=0/);
  const tampered = expired.split(';')[0] + 'tampered';
  assert.match((await readSession(request('account', {}, { Cookie: tampered }), env)).cookie, /Max-Age=0/);
});

test('Firestore commits event changes separately and rejects a stale catalog update', async t => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048,
    publicExponent: Uint8Array.of(1, 0, 1) }, true, ['sign', 'verify']);
  const privateKey = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const env = { GOOGLE_SERVICE_ACCOUNT: JSON.stringify({ type: 'service_account', project_id: projectId,
    client_email: 'test@' + projectId + '.iam.gserviceaccount.com', private_key: privateKey }) };
  const manifest = 'projects/' + projectId + '/databases/(default)/documents/tballPrivate/catalog';
  let commits = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'test', expires_in: 3600 });
    const body = JSON.parse(options.body);
    if (url.endsWith(':batchGet')) return Response.json([{ missing: manifest }]);
    assert.equal(body.writes[0].update.name, manifest);
    assert.deepEqual(body.writes[0].currentDocument, { exists: false });
    assert.match(body.writes[1].update.name, /tballEvents\/fixture-test$/);
    if (commits++) return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 });
    return Response.json({});
  });
  const first = await openCatalog(env);
  const second = await openCatalog(env);
  first.state.events.push({ id: 'fixture-test', number: 1 });
  second.state.events.push({ id: 'fixture-test', number: 1 });
  await first.save();
  await assert.rejects(second.save(), { status: 409 });
});

test('member reset keeps the original UID, retries duplicate codes and consumes the link', async t => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048,
    publicExponent: Uint8Array.of(1, 0, 1) }, true, ['sign', 'verify']);
  const privateKey = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const config = { ...env, TBALL_OWNER_UID: 'owner', GOOGLE_SERVICE_ACCOUNT: JSON.stringify({
    type: 'service_account', project_id: projectId, client_email: 'test-reset@' + projectId + '.iam.gserviceaccount.com',
    private_key: privateKey
  }) };
  const token = 'a'.repeat(64);
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(token))).toString('hex');
  let record = { members: [{ id: 'originalUid', number: 'M0001', loginReset: {
    hash, expiresAt: Date.now() + 10000
  } }], eventIds: [], nextEventNumber: 1 };
  let revision = 1;
  let creates = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/product_registrations/')) return Response.json(enabled);
    if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'test', expires_in: 3600 });
    const data = JSON.parse(options.body);
    if (url.endsWith(':batchGet')) return Response.json([{ found: { updateTime: String(revision),
      fields: { state: { stringValue: JSON.stringify(record) } } } }]);
    if (url.endsWith(':commit')) {
      const [write] = data.writes;
      assert.equal(write.currentDocument.updateTime, String(revision++));
      record = JSON.parse(write.update.fields.state.stringValue);
      return Response.json({});
    }
    assert.equal(data.localId, 'originalUid');
    assert.match(data.email, /^member-[a-f0-9]{40}@accounts\.tball\.invalid$/);
    assert.notEqual(data.password, 'new-code');
    assert.equal(record.members[0].loginReset.hash, undefined);
    if (url.endsWith(':update')) return Response.json({ error: { message: 'USER_NOT_FOUND' } }, { status: 400 });
    assert.ok(url.endsWith('/accounts'));
    if (!creates++) return Response.json({ error: { message: 'EMAIL_EXISTS' } }, { status: 400 });
    return Response.json({ localId: data.localId });
  });
  const call = data => account({ request: request('account', data), env: config });
  assert.equal((await call({ action: 'issueMemberReset', memberId: 'originalUid' })).status, 403);
  const redeem = code => call({ action: 'redeemMemberReset', code, token });
  assert.equal((await redeem('used-code')).status, 409);
  assert.equal(record.members[0].loginReset.hash, hash);
  assert.equal((await redeem('new-code')).status, 200);
  assert.equal((await redeem('other-code')).status, 410);
  assert.equal(record.members[0].number, 'M0001');
  assert.equal(creates, 2);
});
