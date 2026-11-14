import { clubAvailability } from '../../club-access.mjs';
import { activeMember, openCatalog } from '../../firebase-store.mjs';
import { authenticate, clearSession, normalizeCode, readSession, sessionCookie } from '../../firebase-auth.mjs';
import { issueMemberReset, redeemMemberReset } from '../../member-reset.mjs';

const reply = (body, status = 200, cookie) => Response.json(body, { status,
  headers: { 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
const publicAccount = (member, code) => ({ uid: member.id, number: member.number, code });

async function enroll(env, uid) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { state, save } = await openCatalog(env);
    const existing = state.members.find(member => member.id === uid);
    if (existing) return existing.removed ? null : existing;
    const number = 'M' + String(state.members.length + 1).padStart(4, '0');
    const member = { id: uid, number, name: '會員 ' + number };
    state.members.push(member);
    try {
      await save();
      return member;
    } catch (error) {
      if (error.status !== 409 || attempt === 2) throw error;
    }
  }
}

export async function onRequestPost({ request, env }) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) return reply({ error: '請從本站登入。' }, 403);
  const body = await request.text();
  if (body.length > 2048) return reply({ error: '資料過長。' }, 413);
  let data;
  try { data = JSON.parse(body); } catch { return reply({ error: '無法讀取資料。' }, 400); }
  if (data?.action === 'logout') return reply({}, 200, clearSession());
  const unavailable = await clubAvailability();
  if (unavailable) return reply({ error: unavailable.error }, unavailable.status);
  if (!env.GOOGLE_SERVICE_ACCOUNT || !env.TBALL_SESSION_KEY) return reply({ error: '登入服務尚未設定。' }, 503);
  try {
    if (data?.action === 'issueMemberReset') {
      const { token, cookie } = await issueMemberReset(request, env, data.memberId);
      return reply({ token }, 200, cookie);
    }
    if (data?.action === 'redeemMemberReset') {
      await redeemMemberReset(env, data.token, data.code);
      return reply({ reset: true }, 200, clearSession());
    }
    if (data?.action === 'session') {
      const { session, cookie } = await readSession(request, env);
      if (!session) return reply({ user: null }, 200, cookie);
      const { state } = await openCatalog(env);
      const member = activeMember(state, session.uid);
      return member ? reply({ user: publicAccount(member, session.code) }, 200, cookie) :
        reply({ user: null }, 200, clearSession());
    }
    const signup = data?.action === 'signup';
    if (!signup && data?.action !== 'login') return reply({ error: '未知的操作。' }, 400);
    const code = normalizeCode(data.code);
    if (!code) return reply({ error: '登入代號可用中英文、數字及 . _ -，須 6 至 40 字元。' }, 400);
    const session = await authenticate(env, code, signup);
    // Login also completes enrollment if Firebase Auth signup succeeded before a Firestore interruption.
    const member = await enroll(env, session.uid);
    if (!member) return reply({ error: '此帳號已從會員名冊移除。' }, 403, clearSession());
    return reply({ user: publicAccount(member, code) }, 200, await sessionCookie(env, session));
  } catch (error) {
    if (error.authError === 'EMAIL_EXISTS') return reply({ error: '此登入代號已被註冊，請改用另一個代號。若為你的帳號，請直接登入。' }, 409);
    if (['INVALID_LOGIN_CREDENTIALS', 'INVALID_PASSWORD', 'EMAIL_NOT_FOUND', 'USER_DISABLED'].includes(error.authError)) {
      return reply({ error: '登入失敗，請確認登入代號。' }, 401);
    }
    if (error.authStatus === 429 || error.authError === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
      return reply({ error: '登入操作過於頻繁，請稍後再試。' }, 429);
    }
    if (error.status) return reply({ error: error.message }, error.status);
    return reply({ error: '目前無法完成登入操作，請稍後重試。' }, 503);
  }
}
