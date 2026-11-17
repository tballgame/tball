import catalog from '../../catalog.cjs';
import domain from '../../cloud-domain.cjs';
import { readBoardEvent } from '../../firebase-store.mjs';
import { clubAvailability } from '../../club-access.mjs';

const eventIdPattern = /^(?:legacy|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
const noStore = { 'Cache-Control': 'no-store' };
const errorReply = (error, status) => Response.json({ error }, { status, headers: noStore });
const notFound = () => errorReply('找不到這場公開賽事。', 404);

export async function onRequestGet({ request, env, cache = globalThis.caches?.default }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('eventId')?.toLowerCase();
  if (!id || !eventIdPattern.test(id)) return notFound();

  const keyUrl = new URL('/api/board', url.origin);
  keyUrl.searchParams.set('eventId', id);
  const key = new Request(keyUrl);
  try {
    const cached = await cache?.match(key).catch(() => undefined);
    if (cached) return new Response(cached.body, {
      headers: { ...noStore, 'Content-Type': 'application/json', 'X-Tball-Board-Cache': 'HIT' }
    });

    const unavailable = await clubAvailability();
    if (unavailable) return errorReply(unavailable.error, unavailable.status);
    const entry = await readBoardEvent(env, id);
    if (!entry || entry.id !== id || entry.draft) return notFound();
    if (!entry.archived) domain.activateSubmittedScores(entry.tournament);
    const view = catalog.catalogView({ events: [entry], members: [] }, { organizer: false }, id);
    const response = Response.json(view, { headers: { ...noStore, 'X-Tball-Board-Cache': 'MISS' } });
    if (cache) await cache.put(key, new Response(response.clone().body, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10' }
    })).catch(() => {});
    return response;
  } catch {
    return errorReply('目前無法讀取賽況，請稍後再試。', 503);
  }
}
