import { firebaseConfig } from './firebaseConfig.js';
import { accessToken, identity } from './worker-google.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const cookieName = '__Host-tball-session';
const lifetime = 30 * 24 * 60 * 60;
const encode = data => btoa(String.fromCharCode(...data)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
const now = () => Math.floor(Date.now() / 1000);

export function normalizeCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().normalize('NFC').toLowerCase();
  return [...code].length >= 6 && [...code].length <= 40 && /^[\p{L}\p{N}_.-]+$/u.test(code) ? code : null;
}

async function key(env, purpose, algorithm, usage) {
  if (!/^[\w-]{43,}$/.test(env.TBALL_SESSION_KEY ?? '')) throw Error('Session key unavailable');
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(`${firebaseConfig.projectId}:${purpose}:${env.TBALL_SESSION_KEY}`));
  return crypto.subtle.importKey('raw', bytes, algorithm, false, usage);
}

async function authCall(url, payload, form = false) {
  const result = await fetch(url + '?key=' + encodeURIComponent(firebaseConfig.apiKey), {
    method: 'POST', signal: AbortSignal.timeout(10000),
    ...(form ? { body: new URLSearchParams(payload) } : {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    })
  });
  const body = await result.json();
  if (!result.ok) throw Object.assign(Error('Firebase Authentication failed'), {
    authError: body.error?.message?.split(' : ')[0], authStatus: result.status
  });
  return body;
}

async function credentials(env, code) {
  const hmac = await key(env, 'credentials', { name: 'HMAC', hash: 'SHA-256' }, ['sign']);
  const derive = async purpose => new Uint8Array(await crypto.subtle.sign('HMAC', hmac, encoder.encode(purpose + ':' + code)));
  const alias = Array.from((await derive('email')).slice(0, 20), byte => byte.toString(16).padStart(2, '0')).join('');
  const email = `member-${alias}@accounts.tball.invalid`;
  const password = 'T7!' + encode(await derive('password'));
  return { email, password };
}

export async function resetCredentials(env, uid, code) {
  const token = await accessToken(env.GOOGLE_SERVICE_ACCOUNT, firebaseConfig.projectId);
  const base = 'https://identitytoolkit.googleapis.com/v1/projects/' + firebaseConfig.projectId + '/accounts';
  const request = async (suffix, data) => {
    const response = await fetch(base + suffix, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const body = await response.json();
    if (!response.ok) throw Object.assign(Error('Firebase Authentication update failed'), {
      authError: body.error?.message?.split(' : ')[0], authStatus: response.status
    });
    if (body.localId !== uid) throw Error('Unexpected Firebase UID');
  };
  const next = await credentials(env, code);
  try {
    await request(':update', { localId: uid, ...next, validSince: String(now() + 1) });
  } catch (error) {
    if (error.authError !== 'USER_NOT_FOUND') throw error;
    await request('', { localId: uid, ...next });
  }
}

export async function authenticate(env, code, signup) {
  const { email, password } = await credentials(env, code);
  const base = 'https://identitytoolkit.googleapis.com/v1/accounts:';
  const result = await authCall(base + (signup ? 'signUp' : 'signInWithPassword'), { email, password, returnSecureToken: true });
  return { uid: result.localId, email, code, token: result.idToken, refresh: result.refreshToken,
    tokenExpires: now() + Number(result.expiresIn), expires: now() + lifetime };
}

function cookie(value, age) {
  return `${cookieName}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;
}

export const clearSession = () => cookie('', 0);

export async function sessionCookie(env, session) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const secret = await key(env, 'cookie', 'AES-GCM', ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, secret, encoder.encode(JSON.stringify(session)));
  return cookie(encode(iv) + '.' + encode(new Uint8Array(encrypted)), Math.max(0, session.expires - now()));
}

export async function readSession(request, env) {
  const value = request.headers.get('Cookie')?.split(';').map(part => part.trim())
    .find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  if (!value) return {};
  let session;
  const secret = await key(env, 'cookie', 'AES-GCM', ['decrypt']);
  try {
    const [iv, cipher] = value.split('.');
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv) }, secret, decode(cipher));
    session = JSON.parse(decoder.decode(decrypted));
  } catch {
    return { cookie: clearSession() };
  }
  if (session.expires <= now()) return { cookie: clearSession() };
  try {
    let renewed;
    if (session.tokenExpires <= now() + 60) {
      const result = await authCall('https://securetoken.googleapis.com/v1/token', {
        grant_type: 'refresh_token', refresh_token: session.refresh
      }, true);
      if (result.user_id !== session.uid || result.project_id !== undefined && result.project_id !== firebaseConfig.messagingSenderId) {
        return { cookie: clearSession() };
      }
      session.token = result.id_token;
      session.refresh = result.refresh_token;
      session.tokenExpires = now() + Number(result.expires_in);
      renewed = await sessionCookie(env, session);
    }
    const account = await identity('Bearer ' + session.token, firebaseConfig.projectId);
    if (account.uid !== session.uid || account.email !== session.email) return { cookie: clearSession() };
    return { session, cookie: renewed };
  } catch (error) {
    if (error.code === 'INVALID_AUTH' || ['TOKEN_EXPIRED', 'USER_DISABLED', 'USER_NOT_FOUND', 'INVALID_REFRESH_TOKEN'].includes(error.authError)) {
      return { cookie: clearSession() };
    }
    throw error;
  }
}
