import domain from '../../cloud-domain.cjs';
import catalog from '../../catalog.cjs';
import { prepareSimulation } from '../../simulation.mjs';
import { identity, accessToken } from '../../worker-google.mjs';
import { accountEmail } from '../../account.mjs';
import { sessionIdentity } from '../../session-auth.mjs';
import { firebaseConfig } from '../../firebaseConfig.js';
import { clubAvailability, usesLegacyPilot } from '../../club-access.mjs';

const { projectId: project } = firebaseConfig;
const database = 'projects/' + project + '/databases/(default)';
const firestore = 'https://firestore.googleapis.com/v1/' + database + '/documents';
const privatePath = '/tballPrivate/registrationPilot';
const publicPath = '/tballPublic/registrationPilot';
const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
const response = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function getDocument(path, headers) {
  const result = await fetch(firestore + path, { headers, signal: AbortSignal.timeout(10000) });
  if (result.status === 404) return {};
  if (!result.ok) throw Error('Firestore read failed');
  const document = await result.json();
  if (path === publicPath) {
    return { state: Object.fromEntries(Object.entries(document.fields).map(([key, value]) =>
      [key, value.stringValue ?? Number(value.integerValue)])) };
  }
  return { state: JSON.parse(document.fields.state.stringValue), version: document.updateTime };
}

function write(path, state, currentDocument) {
  const fields = path === privatePath ? { state: { stringValue: JSON.stringify(state) } } :
    Object.fromEntries(Object.entries(state).map(([key, value]) =>
      [key, typeof value === 'number' ? { integerValue: String(value) } : { stringValue: value }]));
  return { update: { name: database + '/documents' + path, fields }, currentDocument };
}

async function resetPassword(data, actor, headers) {
  if (!actor.organizer) return response({ error: '只有大會可重設密碼。' }, 403);
  const email = accountEmail(data.username);
  if (!email) return response({ error: '請輸入有效帳號。' }, 400);
  const api = 'https://identitytoolkit.googleapis.com/v1/projects/' + project + '/accounts:';
  const call = (action, payload) => fetch(api + action, {
    method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000)
  });
  const lookup = await call('lookup', { email: [email] });
  if (!lookup.ok) throw Error('Admin account lookup failed');
  const user = (await lookup.json()).users?.find(item => item.email === email);
  if (!user || user.disabled || user.localId === actor.uid) {
    return response({ error: '找不到可重設的參賽帳號。' }, 404);
  }
  const random = crypto.getRandomValues(new Uint8Array(15));
  const password = 'T7!' + btoa(String.fromCharCode(...random)).replaceAll('+', '-').replaceAll('/', '_');
  const result = await call('update', {
    localId: user.localId, password, validSince: String(Math.floor(Date.now() / 1000) + 1)
  });
  if (!result.ok) throw Error('Password reset failed');
  return response({ temporaryPassword: password });
}

async function registrationStore(db, actor, data, auth) {
  let row = await db.prepare('SELECT state, revision FROM registration_state WHERE id = 1').first();
  if (!row && !actor.organizer) {
    if (data.action !== 'view') return response({ error: '請先由大會開啟賽事。' }, 503);
    if (!usesLegacyPilot) return response(catalog.catalogView({ members: [], events: [] }, actor));
    const { state } = await getDocument(publicPath);
    return response({ organizer: false, player: null, event: state ?? null, limitedMode: true });
  }
  if (!row) {
    const { state } = usesLegacyPilot ? await getDocument(privatePath, { Authorization: auth }) : {};
    const initial = domain.migrate(state ?? {});
    if (usesLegacyPilot && !initial.members.some(member => member.demo)) {
      domain.mutate(initial, actor, { action: 'seedPlayers' }, day.format(new Date()));
    }
    await db.prepare('INSERT OR IGNORE INTO registration_state (id, state, revision) VALUES (1, ?, 0)')
      .bind(JSON.stringify(initial)).run();
    row = await db.prepare('SELECT state, revision FROM registration_state WHERE id = 1').first();
  }
  const state = JSON.parse(row.state);
  const migrated = catalog.migrateCatalog(state);
  const member = actor.uid && state.members.find(member => member.id === actor.uid && !member.removed);
  if (actor.uid && !member) return response({ error: '會員資格已變更，請重新登入。' }, 401);
  const newMember = false;
  let result;
  try {
    if (data.action === 'register' &&
        (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().normalize('NFC').toLowerCase() === actor.code)) {
      return response({ error: '請另取公開名稱，請勿使用登入代號。' }, 400);
    }
    const today = day.format(new Date());
    const id = data.action === 'view' ? data.eventId : data.action === 'seedSimulation' ?
      await prepareSimulation(state, actor, today, data.scenario) : catalog.changeCatalog(state, actor, data, today);
    result = catalog.catalogView(state, actor, id);
  } catch (error) {
    return response({ error: error.message }, 409);
  }
  if (data.action !== 'view' || newMember || migrated) {
    const updated = await db.prepare('UPDATE registration_state SET state = ?, revision = revision + 1 WHERE id = 1 AND revision = ?')
      .bind(JSON.stringify(state), row.revision).run();
    if (!updated.meta.changes) return response({ error: '名單剛被更新，請重新整理後再操作。' }, 409);
  }
  return response({ ...result, passwordResetAvailable: false });
}

export async function onRequestPost({ request, env }) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) return response({ error: '請從本站操作。' }, 403);
  const body = await request.text();
  if (body.length > 4096) return response({ error: '要求內容過長。' }, 413);
  let data;
  try { data = JSON.parse(body); } catch { return response({ error: '無法讀取要求。' }, 400); }
  if (typeof data?.action !== 'string') return response({ error: '缺少操作。' }, 400);

  try {
    const unavailable = await clubAvailability(env);
    if (unavailable) return response({ error: unavailable.error }, unavailable.status);
    if (!env.TBALL_DB && !usesLegacyPilot) return response({ error: '球團資料庫尚未設定。' }, 503);
    const auth = request.headers.get('Authorization');
    const account = env.TBALL_DB ? await sessionIdentity(request, env.TBALL_DB) : auth ? await identity(auth, project) : null;
    const uid = account?.uid;
    if (!uid && data.action !== 'view') return response({ error: '請先登入。' }, 401);
    const actor = { uid, name: account?.name, code: account?.code, organizer: Boolean(uid && uid === env.TBALL_OWNER_UID) };
    if (!env.TBALL_OWNER_UID) {
      if (data.action === 'view') return response({ ...domain.view(null, actor), setupPending: true });
      return response({ error: '試用服務尚未完成設定。' }, 503);
    }
    if (env.TBALL_DB) {
      if (data.action === 'resetPassword') return response({ error: '密碼重設尚未開放。' }, 403);
      return await registrationStore(env.TBALL_DB, actor, data, auth);
    }
    const limitedMode = !env.GOOGLE_SERVICE_ACCOUNT;
    if (limitedMode && !actor.organizer) {
      if (data.action !== 'view') return response({ error: '目前僅開放大會管理賽事與名單。' }, 403);
      const { state } = await getDocument(publicPath);
      return response({ organizer: false, player: null, event: state ?? null, limitedMode });
    }
    if (limitedMode && !['view', 'publish', 'seedPlayers', 'close', 'captain', 'lock'].includes(data.action)) {
      return response({ error: '這項功能目前尚未開放。' }, 403);
    }
    const authorization = limitedMode ? auth : 'Bearer ' + await accessToken(env.GOOGLE_SERVICE_ACCOUNT, project);
    const headers = { Authorization: authorization, 'Content-Type': 'application/json' };
    if (data.action === 'resetPassword') return await resetPassword(data, actor, headers);
    const { state, version } = await getDocument(privatePath, headers);
    domain.activateSubmittedScores(state?.tournament);
    if (data.action === 'view') return response({ ...domain.view(state, actor), limitedMode });
    let next;
    try {
      next = domain.mutate(state, actor, data, day.format(new Date()));
    } catch (error) {
      return response({ error: error.message }, 409);
    }
    const precondition = version ? { updateTime: version } : { exists: false };
    const publicEvent = domain.view(next, { uid: null, organizer: false }).event;
    const result = await fetch(firestore + ':commit', {
      method: 'POST', headers, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ writes: [write(privatePath, next, precondition), write(publicPath, publicEvent)] })
    });
    if ([409, 412].includes(result.status)) return response({ error: '資料剛被更新，請重新整理賽事再操作。' }, 409);
    if (!result.ok) throw Error('Firestore write failed');
    return response({ ...domain.view(next, actor), limitedMode });
  } catch (error) {
    if (error.code === 'INVALID_AUTH') return response({ error: '登入已失效，請重新登入。' }, 401);
    return response({ error: '試用服務目前無法讀寫資料。' }, 503);
  }
}
