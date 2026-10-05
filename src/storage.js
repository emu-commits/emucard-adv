// Persistence in IndexedDB: the memory card image (in 1 MiB chunks, so saving rewrites only
// what changed) and downloaded firmware images.

const DB_NAME = 'emucard-adv';
const DB_VERSION = 1;
const CHUNK = 1024 * 1024;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sd')) db.createObjectStore('sd');
      if (!db.objectStoreNames.contains('firmware')) db.createObjectStore('firmware');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  }));
}

const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export async function getMeta(key) {
  try { return await tx('meta', 'readonly', (s) => req(s.get(key))); } catch { return undefined; }
}

export async function setMeta(key, value) {
  try { await tx('meta', 'readwrite', (s) => { s.put(value, key); }); } catch { /* best effort */ }
}

/** The saved card, or null. */
export async function loadCard() {
  try {
    const info = await getMeta('sd');
    if (!info || !info.size) return null;
    const chunks = await tx('sd', 'readonly', async (s) => {
      const out = [];
      for (let i = 0; i < Math.ceil(info.size / CHUNK); i++) out.push(await req(s.get(i)));
      return out;
    });
    const img = new Uint8Array(info.size);
    chunks.forEach((c, i) => { if (c) img.set(new Uint8Array(c), i * CHUNK); });
    lastSaved = img.slice();
    return img;
  } catch {
    return null;
  }
}

let lastSaved = null;

function sameChunk(a, b, off) {
  const n = Math.min(CHUNK, a.length - off);
  const x = new Uint32Array(a.buffer, a.byteOffset + off, n >> 2);
  const y = new Uint32Array(b.buffer, b.byteOffset + off, n >> 2);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Save the card, writing only the chunks that differ from the last save. */
export async function saveCard(img) {
  const full = !lastSaved || lastSaved.length !== img.length;
  const changed = [];
  for (let off = 0, i = 0; off < img.length; off += CHUNK, i++) {
    if (full || !sameChunk(img, lastSaved, off)) changed.push(i);
  }
  if (!changed.length) return 0;
  await tx('sd', 'readwrite', (s) => {
    if (full) s.clear();
    for (const i of changed) s.put(img.slice(i * CHUNK, Math.min((i + 1) * CHUNK, img.length)).buffer, i);
  });
  await setMeta('sd', { size: img.length, saved: Date.now() });
  lastSaved = img.slice();
  return changed.length;
}

export async function forgetCard() {
  lastSaved = null;
  try { await tx('sd', 'readwrite', (s) => { s.clear(); }); await setMeta('sd', null); } catch { /* ignore */ }
}

export async function getFirmware(name) {
  try { return await tx('firmware', 'readonly', (s) => req(s.get(name))); } catch { return undefined; }
}

export async function putFirmware(name, record) {
  try { await tx('firmware', 'readwrite', (s) => { s.put(record, name); }); } catch { /* quota: run uncached */ }
}
