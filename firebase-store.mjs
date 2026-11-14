import { firebaseConfig } from './firebaseConfig.js';
import { accessToken } from './worker-google.mjs';

const root = `projects/${firebaseConfig.projectId}/databases/(default)/documents`;
const endpoint = 'https://firestore.googleapis.com/v1/' + root;
const manifest = root + '/tballPrivate/catalog';
const eventName = id => root + '/tballEvents/' + id;
const encoder = new TextEncoder();
const conflict = () => Object.assign(Error('資料剛被更新，請重試。'), { status: 409 });

function update(name, json) {
  if (encoder.encode(json).length > 1000000) {
    throw Object.assign(Error('本筆賽事或名冊已達儲存上限。'), { status: 409 });
  }
  return { update: { name, fields: { state: { stringValue: json } } } };
}

export async function openCatalog(env) {
  const token = await accessToken(env.GOOGLE_SERVICE_ACCOUNT, firebaseConfig.projectId);
  const call = async (method, body) => {
    const response = await fetch(endpoint + ':' + method, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      if (method === 'commit' && ['ALREADY_EXISTS', 'ABORTED', 'FAILED_PRECONDITION'].includes(details.error?.status)) throw conflict();
      throw Error('Firestore ' + method + ' failed');
    }
    return response.json();
  };
  const [record] = await call('batchGet', { documents: [manifest] });
  const document = record.found;
  const { eventIds, ...state } = document ? JSON.parse(document.fields.state.stringValue) :
    { eventIds: [], members: [], nextEventNumber: 1 };
  const original = new Map();
  for (let offset = 0; offset < eventIds.length; offset += 100) {
    const documents = eventIds.slice(offset, offset + 100).map(eventName);
    const events = await call('batchGet', { documents, readTime: record.readTime });
    for (const { found } of events) {
      if (!found) throw Error('Missing Firestore event');
      original.set(found.name, found.fields.state.stringValue);
    }
  }
  state.events = eventIds.map(id => JSON.parse(original.get(eventName(id))));

  return { state, async save() {
    const { events, ...metadata } = state;
    const writes = [{ ...update(manifest, JSON.stringify({ ...metadata, eventIds: events.map(event => event.id) })),
      currentDocument: document ? { updateTime: document.updateTime } : { exists: false } }];
    const names = new Set();
    for (const event of events) {
      const name = eventName(event.id);
      names.add(name);
      const json = JSON.stringify(event);
      if (original.get(name) !== json) writes.push(update(name, json));
    }
    for (const name of original.keys()) if (!names.has(name)) writes.push({ delete: name });
    await call('commit', { writes });
  } };
}

export function activeMember(state, uid) {
  return uid && state.members.find(member => member.id === uid && !member.removed);
}
