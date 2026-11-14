import { normalizeCode, readSession, resetCredentials } from './firebase-auth.mjs';
import { activeMember, openCatalog } from './firebase-store.mjs';
import { accessToken } from './worker-google.mjs';
import { firebaseConfig } from './firebaseConfig.js';

const fail = (status, message) => Object.assign(Error(message), { status });
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const digest = async token => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
const busy = () => fail(409, '此會員正在重設代號，請稍後再試。');
const permissions = ['firebaseauth.users.update', 'firebaseauth.users.create'];

async function checkResetPermissions(env) {
  const project = firebaseConfig.projectId;
  const access = await accessToken(env.GOOGLE_SERVICE_ACCOUNT, project);
  const response = await fetch('https://cloudresourcemanager.googleapis.com/v1/projects/' + project + ':testIamPermissions', {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
    body: JSON.stringify({ permissions })
  });
  const granted = response.ok ? (await response.json()).permissions ?? [] : [];
  if (!permissions.every(permission => granted.includes(permission))) {
    throw fail(503, '大會尚未完成重設權限設定，請聯絡大會。');
  }
}

export async function issueMemberReset(request, env, memberId) {
  const { session, cookie } = await readSession(request, env);
  if (!session || session.uid !== env.TBALL_OWNER_UID) throw fail(403, '只有大會管理員可重設登入代號。');
  const { state, save } = await openCatalog(env);
  if (!activeMember(state, session.uid)) throw fail(403, '只有大會管理員可重設登入代號。');
  const member = activeMember(state, memberId);
  if (!member?.number || member.manual || member.demo) throw fail(404, '找不到可重設的會員。');
  if (member.loginReset?.busyUntil > Date.now()) throw busy();
  await checkResetPermissions(env);
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  member.loginReset = { hash: await digest(token), expiresAt: Date.now() + 30 * 60 * 1000 };
  await save();
  return { token, cookie };
}

export async function redeemMemberReset(env, token, input) {
  const invalid = () => fail(410, '重設連結已失效。請向大會索取新連結。');
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw invalid();
  const code = normalizeCode(input);
  if (!code) throw fail(400, '新代號可用中英文、數字及 . _ -，須 6 至 40 字元。');
  const hash = await digest(token);
  const { state, save } = await openCatalog(env);
  const member = state.members.find(item => !item.removed && item.loginReset?.hash === hash);
  if (!member || member.loginReset.expiresAt <= Date.now()) throw invalid();
  // Claim the link before changing Firebase Auth. The catalog write uses an update-time precondition.
  const pending = member.loginReset;
  member.loginReset = { claim: hash, busyUntil: Date.now() + 60000 };
  await save();
  try {
    await resetCredentials(env, member.id, code);
  } catch (error) {
    if (error.authError === 'EMAIL_EXISTS') {
      const current = await openCatalog(env);
      const sameMember = activeMember(current.state, member.id);
      if (sameMember?.loginReset?.claim !== hash) throw invalid();
      sameMember.loginReset = pending;
      await current.save();
      throw fail(409, '此代號已被使用，請選另一個代號。');
    }
    if (error.authStatus === 403) throw fail(503, '大會尚未完成重設權限設定，請聯絡大會。');
    throw fail(503, '無法確認代號已重設。請先試用新代號登入，若失敗再向大會索取新連結。');
  }
}
