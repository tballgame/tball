import { firebaseConfig, legacyPilot } from './firebaseConfig.js';

const headquarters = 'https://firestore.googleapis.com/v1/projects/superadmin-9cd4b/databases/(default)/documents';
export const usesLegacyPilot = legacyPilot && firebaseConfig.projectId === 'tball-ef787';

export async function clubAvailability(env, fetcher = fetch, projectId = firebaseConfig.projectId) {
  if (usesLegacyPilot && projectId === firebaseConfig.projectId && env.TBALL_REQUIRE_HQ !== 'true') return null;
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId ?? '')) {
    return { status: 503, error: '球團尚未完成設定。' };
  }
  try {
    const result = await fetcher(headquarters + '/product_registrations/tball/tenants/' + projectId,
      { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (result.status === 404) return { status: 403, error: '此球團尚未啟用。' };
    if (!result.ok) throw Error('Club registration unavailable');
    const { fields } = await result.json();
    if (fields?.productId?.stringValue !== 'tball' || fields?.projectId?.stringValue !== projectId ||
        fields?.registered?.booleanValue !== true || fields?.active?.booleanValue !== true) {
      return { status: 403, error: '此球團尚未啟用或已暫停使用。' };
    }
    return null;
  } catch {
    return { status: 503, error: '目前無法確認球團的啟用狀態，請稍後再試。' };
  }
}
