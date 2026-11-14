import catalog from '../../catalog.cjs';
import { readSession, clearSession } from '../../firebase-auth.mjs';
import { activeMember, openCatalog } from '../../firebase-store.mjs';
import { clubAvailability } from '../../club-access.mjs';

const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
const reply = (body, status = 200, cookie) => Response.json(body, { status,
  headers: { 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) } });

export async function onRequestPost({ request, env }) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) return reply({ error: '請從本站操作。' }, 403);
  const body = await request.text();
  if (body.length > 4096) return reply({ error: '要求內容過長。' }, 413);
  let data;
  try { data = JSON.parse(body); } catch { return reply({ error: '無法讀取要求。' }, 400); }
  if (typeof data?.action !== 'string') return reply({ error: '缺少操作。' }, 400);
  const unavailable = await clubAvailability();
  if (unavailable) return reply({ error: unavailable.error }, unavailable.status);
  try {
    const { session, cookie } = await readSession(request, env);
    const uid = session?.uid;
    if (!uid && data.action !== 'view') return reply({ error: '請先登入。' }, 401, cookie);
    const { state, save } = await openCatalog(env);
    const member = activeMember(state, uid);
    if (uid && !member) return reply({ error: '會員資格已變更，請重新登入。' }, 401, clearSession());
    const actor = { uid, name: member?.name, organizer: Boolean(uid && uid === env.TBALL_OWNER_UID) };
    if (!env.TBALL_OWNER_UID && data.action !== 'view') return reply({ error: '大會帳號尚未設定。' }, 503, cookie);
    catalog.migrateCatalog(state);
    let result;
    try {
      if (data.action === 'register' && (typeof data.name !== 'string' || !data.name.trim() ||
        data.name.trim().normalize('NFC').toLowerCase() === session.code)) {
        return reply({ error: '請另取公開名稱，請勿使用登入代號。' }, 400, cookie);
      }
      const today = day.format(new Date());
      const id = data.action === 'view' ? data.eventId : catalog.changeCatalog(state, actor, data, today);
      result = catalog.catalogView(state, actor, id);
    } catch (error) {
      return reply({ error: error.message }, 409, cookie);
    }
    if (data.action !== 'view') await save();
    return reply({ ...result, passwordResetAvailable: false }, 200, cookie);
  } catch (error) {
    if (error.status === 409) return reply({ error: error.message }, 409);
    return reply({ error: '球團目前無法讀寫資料。' }, 503);
  }
}
