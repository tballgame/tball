import { firebaseConfig } from './firebaseConfig.js';

const keysUrl = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const tokenUrl = 'https://oauth2.googleapis.com/token';
const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
const encoder = new TextEncoder();
let keyCache;
let tokenCache;

function invalid() {
  throw Object.assign(new Error('Invalid Firebase identity'), { code: 'INVALID_AUTH' });
}

function bytes(value) {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
}

function base64url(value) {
  return btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function jsonPart(value) {
  return base64url(encoder.encode(JSON.stringify(value)));
}

export async function identity(authorization, project) {
  const match = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(authorization);
  if (!match || authorization.length > 16384) invalid();
  const [, header, payload, signature] = match;
  let h, claims, signedBytes;
  try {
    const decoder = new TextDecoder();
    h = JSON.parse(decoder.decode(bytes(header)));
    claims = JSON.parse(decoder.decode(bytes(payload)));
    signedBytes = bytes(signature);
  } catch {
    invalid();
  }
  const now = Math.floor(Date.now() / 1000);
  if (h?.alg !== 'RS256' || typeof h.kid !== 'string' ||
      claims?.aud !== project || claims.iss !== 'https://securetoken.google.com/' + project ||
      !/^[\w-]{1,128}$/.test(claims.sub || '') || typeof claims.sub !== 'string' ||
      !Number.isInteger(claims.exp) || claims.exp <= now ||
      !Number.isInteger(claims.iat) || claims.iat < 0 || claims.iat > now ||
      !Number.isInteger(claims.auth_time) || claims.auth_time < 0 || claims.auth_time > now ||
      !/^member-[a-f0-9]{40}@accounts\.tball\.invalid$/.test(claims.email || '') ||
      claims.firebase?.sign_in_provider !== 'password') invalid();
  if (!keyCache || keyCache.until <= now) {
    const result = await fetch(keysUrl, { signal: AbortSignal.timeout(10000) });
    if (!result.ok) throw Error('Firebase public keys unavailable');
    const age = Number(result.headers.get('Cache-Control')?.match(/max-age=(\d+)/)?.[1] || 60);
    keyCache = { keys: (await result.json()).keys, until: now + Math.min(3600, age), imported: new Map() };
  }
  const key = keyCache.keys.find(item => item.kid === h.kid && item.kty === 'RSA');
  if (!key) invalid();
  if (!keyCache.imported.has(h.kid)) {
    keyCache.imported.set(h.kid, crypto.subtle.importKey('jwk', key, algorithm, false, ['verify']));
  }
  const publicKey = await keyCache.imported.get(h.kid);
  if (!await crypto.subtle.verify(algorithm.name, publicKey, signedBytes, encoder.encode(header + '.' + payload))) invalid();
  const lookup = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(firebaseConfig.apiKey), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: match[0].slice(7) }), signal: AbortSignal.timeout(10000)
  });
  if ([400, 401, 403].includes(lookup.status)) invalid();
  if (!lookup.ok) throw Error('Firebase account lookup unavailable');
  const user = (await lookup.json()).users?.find(item => item.localId === claims.sub);
  if (!user || user.disabled === true || user.email !== claims.email ||
      !/^\d+$/.test(String(user.validSince ?? '0')) || claims.auth_time < Number(user.validSince || 0)) invalid();
  return { uid: claims.sub, email: user.email };
}

export async function accessToken(secret, project) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache?.secret === secret && tokenCache.until > now + 60) return tokenCache.value;
  const account = JSON.parse(secret);
  if (account.type !== 'service_account' || account.project_id !== project ||
      !account.client_email?.endsWith('@' + project + '.iam.gserviceaccount.com')) throw Error('Invalid service account');
  const pem = account.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const key = await crypto.subtle.importKey('pkcs8', bytes(pem), algorithm, false, ['sign']);
  const unsigned = jsonPart({ alg: 'RS256', typ: 'JWT' }) + '.' + jsonPart({
    iss: account.client_email, aud: tokenUrl, scope: 'https://www.googleapis.com/auth/cloud-platform', iat: now, exp: now + 3600
  });
  const signature = await crypto.subtle.sign(algorithm.name, key, encoder.encode(unsigned));
  const result = await fetch(tokenUrl, { method: 'POST', signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + base64url(new Uint8Array(signature)) }) });
  if (!result.ok) throw Error('Google OAuth unavailable');
  const data = await result.json();
  if (!data.access_token || !Number.isFinite(data.expires_in)) throw Error('Invalid Google OAuth response');
  tokenCache = { secret, value: data.access_token, until: now + Math.min(3600, data.expires_in) };
  return tokenCache.value;
}
