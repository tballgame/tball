import { normalizeCode, hash, prepareAccounts, sessionIdentity, createSession, deleteSession } from '../../session-auth.mjs';
import { clubAvailability, usesLegacyPilot } from '../../club-access.mjs';

const reply = (body, status = 200, cookie) => {
  const headers = { 'Cache-Control': 'no-store' };
  if (cookie) headers['Set-Cookie'] = cookie;
  return Response.json(body, { status, headers });
};
const duplicateCode = () => reply({
  error: '此登入代號已被註冊，請改用另一個代號。若這是你的帳號，請直接按「登入」。'
}, 409);

export async function onRequestPost({ request, env }) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) return reply({ error: '請從本站登入。' }, 403);
  if (!env.TBALL_DB || !env.TBALL_OWNER_UID) return reply({ error: '登入服務尚未設定。' }, 503);
  const body = await request.text();
  if (body.length > 2048) return reply({ error: '資料過長。' }, 413);
  let data;
  try { data = JSON.parse(body); } catch { return reply({ error: '無法讀取資料。' }, 400); }
  const db = env.TBALL_DB;
  try {
    if (data.action === 'logout') return reply({}, 200, await deleteSession(request, db));
    const unavailable = await clubAvailability(env);
    if (unavailable) return reply({ error: unavailable.error }, unavailable.status);
    await prepareAccounts(db, env.TBALL_OWNER_UID, {
      legacy: usesLegacyPilot, ownerHash: env.TBALL_OWNER_CODE_HASH
    });
    if (data.action === 'session') {
      const actor = await sessionIdentity(request, db);
      if (!actor) return reply({ user: null });
      const row = await db.prepare('SELECT state FROM registration_state WHERE id=1').first();
      const member = JSON.parse(row.state).members.find(member => member.id === actor.uid && !member.removed);
      if (!member) return reply({ user: null }, 200, await deleteSession(request, db));
      return reply({ user: { uid: member.id, number: member.number, code: actor.code } });
    }
    const code = normalizeCode(data.code, data.action === 'login');
    if (!code) return reply({ error: '登入代號可用中英文、數字及 . _ -。新代號須 6 至 40 字元。' }, 400);
    const codeHash = await hash(code);
    let account = await db.prepare('SELECT member_id FROM login_accounts WHERE code_hash=?').bind(codeHash).first();
    if (data.action === 'signup') {
      if (account) return duplicateCode();
      const row = await db.prepare('SELECT state, revision FROM registration_state WHERE id=1').first();
      const state = JSON.parse(row.state);
      const id = crypto.randomUUID();
      const number = 'M' + String(state.members.length + 1).padStart(4, '0');
      state.members.push({ id, number, name: '會員 ' + number, loginHash: codeHash });
      const results = await db.batch([
        db.prepare('UPDATE registration_state SET state=?, revision=revision+1 WHERE id=1 AND revision=?')
          .bind(JSON.stringify(state), row.revision),
        db.prepare('INSERT INTO login_accounts (member_id, code_hash) SELECT ?, ? WHERE EXISTS ' +
          "(SELECT 1 FROM registration_state, json_each(registration_state.state, '$.members') WHERE json_extract(value, '$.id')=?)")
          .bind(id, codeHash, id)
      ]);
      if (!results[0].meta.changes) return reply({ error: '名冊剛被更新，請重試。' }, 409);
      account = { member_id: id };
    } else if (data.action !== 'login') {
      return reply({ error: '未知的操作。' }, 400);
    }
    if (!account) return reply({ error: '登入失敗，請確認登入代號。' }, 401);
    const row = await db.prepare('SELECT state FROM registration_state WHERE id=1').first();
    const member = JSON.parse(row.state).members.find(member => member.id === account.member_id && !member.removed);
    if (!member) return reply({ error: '登入失敗，請確認登入代號。' }, 401);
    return reply({ user: { uid: member.id, number: member.number, code } }, 200, await createSession(db, member.id, code));
  } catch (error) {
    if (data.action === 'signup' && String(error.message).includes('UNIQUE constraint failed: login_accounts.code_hash')) {
      return duplicateCode();
    }
    return reply({ error: '目前無法完成登入操作，請稍後重試。' }, 503);
  }
}
