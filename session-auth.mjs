const cookieName = '__Host-tball-session';
const lifetime = 180 * 24 * 60 * 60;
const encoder = new TextEncoder();
const originalAccounts = new Map([
  ['AbXcxsSaHMNmmUcQrLFeuM4o5P83', '01e3b7a127e548d94173609122a8930d7c485886a9b11d80c2142c8c215267f4'],
  ['3ADLWEcmHWcEjnZtuO5Z66RVPgj2', 'f4baf901d1b9fcc11a9d3c714fda524455a9875aececc7a30b202a058bc696e6'],
  ['YfNws3vR4kMhVC22l4uI7PaVvL22', '44bac339ae3a5d63babca7865ede63ce752a7f9895ecbac4f511524b179992c3'],
  ['YKfcqvSizLOMpqSYhI92oXSYAsb2', 'd917e7647e78484ddaa6c52c3358bfc0909c4a0a60b1c5cb396b3b45a0a841f9'],
  ['li1hgA9i5Aa11pxWDw9YJOhtUyd2', '862e55a06e07c38d9dd707bbc868ceaffc2286d57fa18af0e25e882c0061e40f']
]);

export function normalizeCode(value, existing = false) {
  if (typeof value !== 'string') return null;
  const code = value.trim().normalize('NFC').toLowerCase();
  const minimum = existing ? 3 : 6;
  return code.length >= minimum && code.length <= 40 && /^[\p{L}\p{N}_.-]+$/u.test(code) ? code : null;
}

export async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));

async function sessionKey(token) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode('tball-code:' + token));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function sealCode(code, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sessionKey(token), encoder.encode(code));
  return encode(iv) + '.' + encode(new Uint8Array(encrypted));
}

async function openCode(cipher, token) {
  const [iv, encrypted] = cipher.split('.');
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv) }, await sessionKey(token), decode(encrypted));
  return new TextDecoder().decode(clear);
}

function tokenFrom(request) {
  const token = request.headers.get('Cookie')?.split(';').map(part => part.trim())
    .find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  return token && /^[\w-]{43}$/.test(token) ? token : null;
}

export async function prepareAccounts(db, ownerUid, { legacy = true, ownerHash } = {}) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS registration_state (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, revision INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS login_accounts (member_id TEXT PRIMARY KEY, code_hash TEXT UNIQUE NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS login_sessions (token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, code_cipher TEXT NOT NULL, expires INTEGER NOT NULL)'),
    db.prepare('CREATE INDEX IF NOT EXISTS login_sessions_expiry ON login_sessions(expires)')
  ]);
  if (!legacy) {
    await db.prepare('INSERT OR IGNORE INTO registration_state (id, state, revision) VALUES (1, ?, 0)')
      .bind(JSON.stringify({ members: [], events: [], nextEventNumber: 1 })).run();
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db.prepare('SELECT state, revision FROM registration_state WHERE id=1').first();
    if (!row) throw Error('Member database unavailable');
    const state = JSON.parse(row.state);
    let changed = false;
    if (!state.members.some(member => member.id === ownerUid)) {
      state.members.push({ id: ownerUid, name: '大會管理者' });
      changed = true;
    }
    for (const id of legacy ? originalAccounts.keys() : []) {
      if (!state.members.some(member => member.id === id)) {
        state.members.push({ id, name: '會員' });
        changed = true;
      }
    }
    let testIndex = 0;
    for (const [index, member] of state.members.entries()) {
      const oldName = member.name;
      const testMember = member.demo || member.manual;
      if (testMember) testIndex++;
      if (!member.number) {
        member.number = 'M' + String(index + 1).padStart(4, '0');
        changed = true;
      }
      if (!member.loginHash) {
        if (!legacy) {
          if (member.id !== ownerUid || !/^[a-f0-9]{64}$/.test(ownerHash ?? '')) throw Error('Club account requires setup');
          member.loginHash = ownerHash;
          changed = true;
          continue;
        }
        const code = member.id === ownerUid ? 'icered' : testMember
          ? 'test' + String(testIndex).padStart(2, '0') : normalizeCode(oldName, true);
        if (!code && !originalAccounts.has(member.id)) throw Error('Existing account requires review');
        member.loginHash = originalAccounts.get(member.id) ?? await hash(code);
        const isLoginName = async name => {
          const normalized = normalizeCode(name, true);
          return normalized && await hash(normalized) === member.loginHash;
        };
        if (!testMember && (await isLoginName(oldName) || oldName === '會員')) member.name = '會員 ' + member.number;
        if (member.id === ownerUid) member.name = '大會管理者';
        for (const entry of state.events ?? []) {
          for (const player of entry.event.players) {
            const belongs = player.uid === member.id || player.memberId === member.id;
            if (belongs && await isLoginName(player.name)) player.name = member.name;
            if (belongs && testMember) player.uid = member.id;
          }
          for (const team of entry.tournament?.teams ?? []) {
            for (const player of team.players) {
              if (player.memberId === member.id || player.uid === member.id) {
                if (await isLoginName(player.name)) player.name = member.name;
                if (testMember) player.uid = member.id;
              }
            }
          }
        }
        changed = true;
      }
    }
    let aliasIndex = 0;
    for (const member of state.members) {
      if (member.demo || member.manual) aliasIndex++;
      if (!legacy || !member.demo || aliasIndex > 30) continue;
      const testCode = 'test' + String(aliasIndex).padStart(2, '0');
      if (member.name !== testCode && member.loginHash === await hash(testCode)) {
        member.name = testCode;
        changed = true;
      }
    }
    if (changed) {
      const update = await db.prepare('UPDATE registration_state SET state=?, revision=revision+1 WHERE id=1 AND revision=?')
        .bind(JSON.stringify(state), row.revision).run();
      if (!update.meta.changes) continue;
    }
    await db.prepare(`INSERT OR IGNORE INTO login_accounts (member_id, code_hash)
      SELECT json_extract(member.value, '$.id'), json_extract(member.value, '$.loginHash')
      FROM registration_state, json_each(registration_state.state, '$.members') AS member
      WHERE registration_state.id=1 AND json_extract(member.value, '$.loginHash') IS NOT NULL`).run();
    return;
  }
  throw Error('Member database busy');
}

export async function sessionIdentity(request, db) {
  const token = tokenFrom(request);
  if (!token) return null;
  const session = await db.prepare('SELECT member_id, code_cipher FROM login_sessions WHERE token_hash=? AND expires>?')
    .bind(await hash(token), Math.floor(Date.now() / 1000)).first();
  if (!session) return null;
  return { uid: session.member_id, code: await openCode(session.code_cipher, token) };
}

export async function createSession(db, memberId, code) {
  const token = encode(crypto.getRandomValues(new Uint8Array(32)));
  const expires = Math.floor(Date.now() / 1000) + lifetime;
  await db.prepare('INSERT INTO login_sessions (token_hash, member_id, code_cipher, expires) VALUES (?, ?, ?, ?)')
    .bind(await hash(token), memberId, await sealCode(code, token), expires).run();
  return cookieName + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + lifetime;
}

export async function deleteSession(request, db) {
  const token = tokenFrom(request);
  if (token) await db.prepare('DELETE FROM login_sessions WHERE token_hash=?').bind(await hash(token)).run();
  return cookieName + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}
